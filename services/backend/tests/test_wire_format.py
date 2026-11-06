"""Interop vectors pinned in docs/API_CONTRACTS.md (shared with the app and agent)."""

from app.pricing import inr_price, inr_to_usdc
from app.security import (
    GatewayIdentity,
    callback_signature,
    canonical_json,
    hashscan_for,
    verify_callback,
)

SEED = bytes(range(1, 33))  # 0102…1f20


def test_gateway_public_key_vector():
    assert GatewayIdentity.from_seed(SEED).public_key == "ebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ"


def test_qr_canonical_string_and_signature_vector():
    unsigned = {
        "type": "inklink_shop",
        "version": "1.0",
        "shopId": "shop_001",
        "gatewayId": "gateway_001",
        "gateway": {"discovery": "local", "mdns": "gateway-001.local", "ip": "192.168.1.20", "port": 8000},
        "publicKey": "ebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ",
        "nonce": "AAECAwQFBgcICQoL",
        "expiresAt": "2030-01-01T00:00:00.000Z",
    }
    expected = (
        '{"expiresAt":"2030-01-01T00:00:00.000Z","gateway":{"discovery":"local","ip":"192.168.1.20",'
        '"mdns":"gateway-001.local","port":8000},"gatewayId":"gateway_001","nonce":"AAECAwQFBgcICQoL",'
        '"publicKey":"ebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ","shopId":"shop_001","type":"inklink_shop","version":"1.0"}'
    )
    assert canonical_json(unsigned) == expected
    sig = GatewayIdentity.from_seed(SEED).sign(expected)
    assert sig == "w2YMAQjC9utmmpS7z_Tnxm9HxrYdDkDyQrunujR761f79w2TrD7cXidRUDPPozmGAUh7PSJfND1io_8_n6McAQ"


def test_pairing_challenge_signature_vector():
    sig = GatewayIdentity.from_seed(SEED).sign("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")
    assert sig == "lz3N-oxfN0f_KDlpeh0UvEhCzn_iG0Aznh-wEUfZq-9Y_Pp5BecE3Ay-BIkuJiF0KV1Y7WZA-F-tsysP5VYZAQ"


def test_callback_hmac_vector_and_verification():
    raw = b'{"paymentId":"payment_1","jobId":"job_1","amount":"0.10"}'
    sig = callback_signature("test-secret-0123456789abcdef", "1700000000", raw)
    assert sig == "sha256=47e949af76798bac7c53f33164612740179350ac8897c06c18e4142d8526d43c"
    headers = {"x-inklink-timestamp": "1700000000", "x-inklink-signature": sig}
    assert verify_callback(raw, headers, "test-secret-0123456789abcdef", now=1700000100) is None
    assert verify_callback(raw, headers, "test-secret-0123456789abcdef", now=1700000400) == "STALE_TIMESTAMP"
    assert verify_callback(raw + b" ", headers, "test-secret-0123456789abcdef", now=1700000100) == "BAD_SIGNATURE"
    assert verify_callback(raw, {}, "x") == "MISSING_HEADERS"


def test_fx_policy_rounds_up_to_six_decimals():
    assert inr_to_usdc("20.00", "0.005") == "0.10"
    assert inr_to_usdc("1.00", "0.0123456") == "0.012346"  # rounded up, never down
    assert inr_price(3, 2, "2.00") == "12.00"


def test_hashscan_url_derivation_matches_mock():
    assert hashscan_for("0.0.123@1700000000.000000001") == (
        "https://hashscan.io/testnet/transaction/0.0.123-1700000000-000000001"
    )
