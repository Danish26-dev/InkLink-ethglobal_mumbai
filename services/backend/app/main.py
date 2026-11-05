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

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .config import get_settings
from .routes_native import router as native_router
from .routes_shop import router as shop_router
from .routes_web import router as web_router
from .security import GatewayIdentity


def create_app() -> FastAPI:
    s = get_settings()
    app = FastAPI(title="Inklink Backend", version="0.1.0")
    app.state.identity = GatewayIdentity.load_or_create(s.data_dir / "gateway_ed25519.key")

    if s.allowed_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=s.allowed_origins,
            allow_methods=["GET", "POST", "PUT", "DELETE"],
            allow_headers=["authorization", "content-type", "idempotency-key", "last-event-id"],
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
    async def health():  # unauthenticated; nothing sensitive
        return {"ok": True, "service": "inklink-backend", "paymentsConfigured": s.payments_configured}

    app.include_router(web_router)
    app.include_router(native_router)
    app.include_router(shop_router)
    return app


app = create_app()

if __name__ == "__main__":
    import uvicorn

    settings = get_settings()
    uvicorn.run(app, host=settings.host, port=settings.port)
