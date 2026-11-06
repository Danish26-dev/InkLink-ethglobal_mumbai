"""Response shapes shared by the routers (JobView, ShopChannel, Contract 1/8)."""

from __future__ import annotations

from typing import Any

from . import zerog
from .clients import agent_health
from .config import get_settings
from .jobs import quote_contract
from .store import JobRecord, get_store, now_iso


def job_view(job: JobRecord) -> dict[str, Any]:
    store = get_store()
    quote = store.quotes.get(job.quote_id) if job.quote_id else None
    doc = job.document
    return {
        "jobId": job.job_id,
        "shopId": job.shop_id,
        "status": job.status,
        "paymentStatus": job.payment_status,
        "deviceStatus": job.device_status,
        "document": None
        if not doc
        else {
            "documentId": doc.document_id,
            "filename": doc.filename,
            "format": doc.format,
            "size": doc.size,
            "edited": bool(doc.edited_path),
            "pageCount": doc.page_count,
            "reviewRecommended": doc.review_recommended,
            "notes": doc.notes,
            "editStatus": doc.edit_status,
            "available": not doc.purged,
            "classification": None
            if not doc.classification
            else {k: doc.classification.get(k) for k in ("level", "categories", "reason")},
        },
        "privacy": privacy_view(job),
        "operatorConfig": job.operator_config,
        "configValidated": job.config_validated,
        "quote": quote_contract(quote) if quote else None,
        "customerApprovedQuote": job.customer_approved_quote,
        "shopApproved": job.shop_approved,
        "executionRequested": job.execution_requested,
        "runActive": job.run_active,
        "submission": job.submission,
        "demo": get_store().is_demo_shop(job.shop_id),
        # Jury demo only. Simulated steps are reported separately from real status.
        "simulation": job.simulation or None,
        "deviceEvents": job.device_events[-10:],
        "createdAt": job.created_at,
        "updatedAt": job.updated_at,
    }


def privacy_view(job: JobRecord) -> dict[str, Any]:
    """Trust-mode decision and 0G call metadata. Never includes keys or content."""
    sel = job.trust_selection or {}
    last = job.inference_log[-1] if job.inference_log else None
    return {
        "requestedTrustMode": job.requested_trust_mode,
        "selection": None
        if not sel
        else {k: sel.get(k) for k in (
            "requiredTrustMode", "requestedTrustMode", "shopMinimumTrustMode", "effectiveTrustMode",
            "reason", "raisedBy", "documentLevel", "provider", "model", "error", "at")},
        "inferenceCalls": len(job.inference_log),
        "lastInference": None
        if not last
        else {k: last.get(k) for k in ("at", "trustMode", "model", "ok", "provider", "requestId", "teeVerified", "errorCode")},
    }


def job_status(job: JobRecord) -> dict[str, Any]:
    """Contract 8."""
    return {
        "jobId": job.job_id,
        "status": job.status,
        "paymentStatus": job.payment_status,
        "deviceStatus": job.device_status,
        "updatedAt": job.updated_at or now_iso(),
    }


def shop_contract(shop_id: str | None = None) -> dict[str, Any]:
    """Contract 1."""
    s = get_settings()
    cfg = get_store().shop_config(shop_id)
    return {
        "shopId": cfg["shopId"],
        "gatewayId": s.gateway_id,
        "name": cfg["name"],
        "protocolVersion": "1.0",
        "capabilities": {"localPrinting": True, "pdf": True, "docx": True, "aiEditing": True, "offlineMode": False},
        "connection": {"localGatewayAvailable": True, "internetAvailable": True},
    }


async def agent_status() -> dict[str, Any]:
    """Agent reachability plus the backend's own 0G configuration (no secrets)."""
    s = get_settings()
    zg = zerog.status()
    configured = [m for m, v in zg["modes"].items() if v["configured"]]
    base = {"zeroG": zg}
    health = await agent_health()
    if not health:
        return {**base, "available": False, "provider": "unknown", "model": None, "trustMode": None,
                "reason": "The print operator service is not reachable."}
    mp = health.get("modelProvider") or {}
    runs = bool(health.get("operatorRunsEnabled"))
    provider = mp.get("provider", "unknown")
    if not runs:
        reason = "AGENT_SERVICE_TOKEN is not configured on the agent service."
        available = False
    elif provider == "0g-private-computer":
        available = bool(configured)
        reason = None if available else "No ZERO_G_STANDARD/VERIFIED/PRIVATE_API_KEY is configured on the backend."
    else:
        available = bool(mp.get("available"))
        reason = mp.get("reason")
    default = s.zero_g_default_trust_mode
    return {
        **base,
        "available": available,
        "provider": provider,
        "model": zg["modes"].get(default, {}).get("model") if provider == "0g-private-computer" else mp.get("model"),
        "trustMode": default if provider == "0g-private-computer" else None,
        "reason": None if available else reason,
    }


async def shop_channel(shop_id: str | None = None) -> dict[str, Any]:
    cfg = get_store().shop_config(shop_id)
    agent = await agent_status()
    return {
        "shopId": cfg["shopId"],
        "name": cfg["name"],
        "acceptingOrders": bool(cfg.get("acceptingOrders", True)),
        "agentAvailable": agent["available"],
        "description": cfg.get("description", ""),
        "demo": cfg["demo"],
    }
