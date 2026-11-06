"""Inklink backend — FastAPI.

Owns the authoritative job state and connects the services:

  web app / native app ──▶ backend ──▶ strands-agent (print operator, NDJSON events)
                              │   └──▶ document engine (edited output)
                              │   └──▶ local printer adapter (discovery, validation, print)
                              └──▶ payment agent ──▶ x402 gate ──▶ Hedera
                              ▲                                   │
                              └──── signed settlement callback ───┘

Browsers receive job events over SSE: GET /api/v1/jobs/{jobId}/events.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import chain, gateway_relay, zerog
from .config import get_settings
from .devices import router as devices_router
from .manage import bootstrap_shopkeeper_from_env
from .store import get_store

# uvicorn configures this logger (INFO to stdout -> Cloud Logging).
log = logging.getLogger("uvicorn.error")
from .inference import router as inference_router
from .jury import router as jury_router
from .routes_shop_auth import router as shop_auth_router
from .retention import retention_loop
from .routes_native import payment_reconcile_loop
from .routes_native import router as native_router
from .routes_shop import router as shop_router
from .routes_web import router as web_router
from .security import GatewayIdentity


@asynccontextmanager
async def lifespan(_app: FastAPI):
    try:
        created = bootstrap_shopkeeper_from_env()
        if created:
            log.info("Bootstrap shopkeeper account %s created or password synced", created)
    except ValueError as exc:  # e.g. a password below the minimum length
        log.warning("Bootstrap shopkeeper not created: %s", exc)
    task = asyncio.create_task(retention_loop())
    reconcile = asyncio.create_task(payment_reconcile_loop())
    chain_sender = asyncio.create_task(chain.sender_loop())  # idle until the registry is configured
    try:
        yield
    finally:
        task.cancel()
        reconcile.cancel()
        chain_sender.cancel()
        # Graceful shutdown (Cloud Run sends SIGTERM): release long-polls, write pending state.
        gateway_relay.shutdown()
        get_store().close()


def create_app() -> FastAPI:
    s = get_settings()
    app = FastAPI(title="Inklink Backend", version="0.1.0", lifespan=lifespan)
    app.state.identity = GatewayIdentity.load_configured(s)

    if s.allowed_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=s.allowed_origins,
            allow_methods=["GET", "POST", "PUT", "DELETE"],
            allow_headers=["authorization", "content-type", "idempotency-key", "last-event-id", "x-inklink-request", "x-inklink-shop"],
            allow_credentials=True,
        )

    @app.exception_handler(HTTPException)
    async def _http_error(_req: Request, exc: HTTPException):
        # Agreed error envelope: { success:false, error:{ code, message } } with a matching status.
        if isinstance(exc.detail, dict) and exc.detail.get("success") is False:
            return JSONResponse(status_code=exc.status_code, content=exc.detail)
        return JSONResponse(status_code=exc.status_code,
                            content={"success": False, "error": {"code": "INTERNAL_ERROR", "message": str(exc.detail)}})

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_req: Request, exc: RequestValidationError):
        first = exc.errors()[0] if exc.errors() else {}
        where = ".".join(str(p) for p in first.get("loc", []) if p != "body")
        return JSONResponse(status_code=400, content={"success": False, "error": {
            "code": "POLICY_VIOLATION", "message": f"Invalid request: {where} {first.get('msg', '')}".strip()}})

    @app.get("/health")
    async def health():  # unauthenticated; nothing sensitive (no keys, only which modes are configured)
        zg = zerog.status()
        return {
            "ok": True,
            "service": "inklink-backend",
            "paymentsConfigured": s.payments_configured,
            "printer": gateway_relay.status(),
            "zeroG": {"defaultTrustMode": zg["defaultTrustMode"],
                      "modes": {m: v["configured"] for m, v in zg["modes"].items()}},
        }

    @app.get("/api/v1/health")
    async def api_health():
        return await health()

    @app.get("/api/v1/chain/status")
    async def chain_status():  # public: contract address, network, record counts (no secrets)
        return chain.status()

    app.include_router(web_router)
    app.include_router(native_router)
    app.include_router(shop_router)
    app.include_router(inference_router)
    app.include_router(shop_auth_router)
    app.include_router(devices_router)
    app.include_router(jury_router)
    app.include_router(gateway_relay.router)
    mount_frontends(app, s)
    return app


_PWA_PREFIXES = ("app", "shop", "demo", "portal", "jury")


def mount_frontends(app: FastAPI, s) -> None:
    """Single-origin production serving when the builds exist (dev uses Vite instead).

    /           landing page build (LANDING_DIST_DIR)
    /pwa/*      PWA assets (WEB_DIST_DIR, built with base /pwa/)
    /app, /shop, /demo and their sub-paths -> PWA index.html
    """
    web = Path(s.web_dist_dir) if s.web_dist_dir else None
    landing = Path(s.landing_dist_dir) if s.landing_dist_dir else None
    if web and (web / "index.html").is_file():
        app.mount("/pwa", StaticFiles(directory=web, html=True), name="pwa")

        async def service_worker(_web: Path = web):
            return FileResponse(_web / "sw.js", media_type="text/javascript", headers={"cache-control": "no-cache"})

        app.add_api_route("/sw.js", service_worker, include_in_schema=False)

        for prefix in _PWA_PREFIXES:
            async def pwa_index(_rest: str = "", _web: Path = web):
                return FileResponse(_web / "index.html")

            app.add_api_route(f"/{prefix}", pwa_index, include_in_schema=False)
            app.add_api_route(f"/{prefix}/{{_rest:path}}", pwa_index, include_in_schema=False)
    if landing and (landing / "index.html").is_file():
        app.mount("/", StaticFiles(directory=landing, html=True), name="landing")


app = create_app()

if __name__ == "__main__":
    import uvicorn

    settings = get_settings()
    uvicorn.run(app, host=settings.host, port=settings.port)
