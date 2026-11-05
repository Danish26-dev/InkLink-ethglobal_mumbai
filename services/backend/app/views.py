"""Response shapes shared by the routers (JobView, ShopChannel, Contract 1/8)."""

from __future__ import annotations

from typing import Any

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
        },
        "operatorConfig": job.operator_config,
        "configValidated": job.config_validated,
        "quote": quote_contract(quote) if quote else None,
        "customerApprovedQuote": job.customer_approved_quote,
        "shopApproved": job.shop_approved,
        "executionRequested": job.execution_requested,
        "runActive": job.run_active,
        "submission": job.submission,
        "createdAt": job.created_at,
        "updatedAt": job.updated_at,
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


def shop_contract() -> dict[str, Any]:
    """Contract 1."""
    s = get_settings()
    cfg = get_store().shop_config()
    return {
        "shopId": s.shop_id,
        "gatewayId": s.gateway_id,
        "name": cfg["name"],
        "protocolVersion": "1.0",
        "capabilities": {"localPrinting": True, "pdf": True, "docx": True, "aiEditing": True, "offlineMode": False},
        "connection": {"localGatewayAvailable": True, "internetAvailable": True},
    }


async def agent_status() -> dict[str, Any]:
    health = await agent_health()
    if not health:
        return {"available": False, "provider": "unknown", "model": None, "trustMode": None,
                "reason": "The print operator service is not reachable."}
    mp = health.get("modelProvider") or {}
    runs = bool(health.get("operatorRunsEnabled"))
    available = bool(mp.get("available")) and runs
    reason = mp.get("reason") or (None if runs else "AGENT_SERVICE_TOKEN is not configured on the agent service.")
    return {
        "available": available,
        "provider": mp.get("provider", "unknown"),
        "model": mp.get("model"),
        "trustMode": mp.get("trustMode"),
        "reason": None if available else reason,
    }


async def shop_channel() -> dict[str, Any]:
    s = get_settings()
    cfg = get_store().shop_config()
    agent = await agent_status()
    return {
        "shopId": s.shop_id,
        "name": cfg["name"],
        "acceptingOrders": bool(cfg.get("acceptingOrders", True)),
        "agentAvailable": agent["available"],
        "description": cfg.get("description", ""),
    }
