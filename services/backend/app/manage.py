"""Backend administration CLI (run on the shop server, never exposed over HTTP).

    python -m app.manage create-shopkeeper --email owner@example.com --name "Owner" --shops shop_001
    python -m app.manage list-shopkeepers
    python -m app.manage set-password --email owner@example.com
    python -m app.manage disable --email owner@example.com
    python -m app.manage register-shop --shop-id shop_002 --name "Second shop"

Passwords are read with getpass (or INKLINK_NEW_PASSWORD for automation) and
stored only as scrypt hashes in DATA_DIR/state.json.
"""

from __future__ import annotations

import argparse
import getpass
import os
import sys

from .auth import hash_password, new_account
from .store import get_store


def _password() -> str:
    pw = os.environ.get("INKLINK_NEW_PASSWORD")
    if pw:
        return pw
    first = getpass.getpass("Password (min 10 characters): ")
    if first != getpass.getpass("Repeat password: "):
        sys.exit("Passwords do not match.")
    return first


def bootstrap_shopkeeper_from_env() -> str | None:
    """Create the first shopkeeper on a server without a shell (Cloud Run).

    BOOTSTRAP_SHOPKEEPER_EMAIL / _NAME / _SHOPS and BOOTSTRAP_SHOPKEEPER_PASSWORD
    (a Secret Manager secret). Runs at startup; does nothing when the variables are
    unset or the account already exists, so an existing password is never replaced.
    Returns the created account id (for logging), else None.
    """
    email = os.environ.get("BOOTSTRAP_SHOPKEEPER_EMAIL", "").strip().lower()
    password = os.environ.get("BOOTSTRAP_SHOPKEEPER_PASSWORD", "")
    if not email or not password:
        return None
    store = get_store()
    if any(a.email == email for a in store.accounts.values()):
        return None
    name = os.environ.get("BOOTSTRAP_SHOPKEEPER_NAME", "").strip() or "Shop owner"
    wanted = [s.strip() for s in os.environ.get("BOOTSTRAP_SHOPKEEPER_SHOPS", "").split(",") if s.strip()]
    shops = [s for s in (wanted or store.shop_ids()) if s in store.shop_ids()]
    acct = new_account(email, name, password, shops, "owner")  # ValueError on a weak password
    with store.lock:
        store.accounts[acct.account_id] = acct
        store.save()
    return acct.account_id


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="python -m app.manage")
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("create-shopkeeper")
    c.add_argument("--email", required=True)
    c.add_argument("--name", required=True)
    c.add_argument("--shops", required=True, help="comma-separated shop ids, e.g. shop_001,shop_demo")
    c.add_argument("--role", default="owner", choices=["owner", "admin"])
    sub.add_parser("list-shopkeepers")
    sp = sub.add_parser("set-password")
    sp.add_argument("--email", required=True)
    d = sub.add_parser("disable")
    d.add_argument("--email", required=True)
    r = sub.add_parser("register-shop")
    r.add_argument("--shop-id", required=True)
    r.add_argument("--name", required=True)
    r.add_argument("--description", default="")
    args = p.parse_args(argv)

    store = get_store()
    by_email = {a.email: a for a in store.accounts.values()}
    if args.cmd == "create-shopkeeper":
        email = args.email.strip().lower()
        if email in by_email:
            sys.exit("An account with this email already exists.")
        shops = [s.strip() for s in args.shops.split(",") if s.strip()]
        unknown = [s for s in shops if s not in store.shop_ids()]
        if unknown:
            sys.exit(f"Unknown shop id(s): {', '.join(unknown)}. Known: {', '.join(store.shop_ids())}")
        try:
            acct = new_account(email, args.name, _password(), shops, args.role)
        except ValueError as exc:
            sys.exit(str(exc))
        with store.lock:
            store.accounts[acct.account_id] = acct
            store.save()
        print(f"Created {acct.account_id} for {email} managing {', '.join(shops)}.")
    elif args.cmd == "list-shopkeepers":
        for a in store.accounts.values():
            print(f"{a.account_id}\t{a.email}\t{a.role}\t{','.join(a.shop_ids)}\t{'disabled' if a.disabled else 'active'}")
    elif args.cmd in ("set-password", "disable"):
        acct = by_email.get(args.email.strip().lower())
        if not acct:
            sys.exit("No such account.")
        with store.lock:
            if args.cmd == "disable":
                acct.disabled = True
                for k, sess in list(store.shop_sessions.items()):
                    if sess.account_id == acct.account_id:
                        store.shop_sessions.pop(k, None)
            else:
                acct.password_hash = hash_password(_password())
            store.save()
        print("Done.")
    elif args.cmd == "register-shop":
        with store.lock:
            store.shops.setdefault(args.shop_id, {}).update({"registered": True, "name": args.name, "description": args.description})
            store.save()
        print(f"Registered {args.shop_id}.")


if __name__ == "__main__":
    main()
