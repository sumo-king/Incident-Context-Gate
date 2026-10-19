"""FastAPI service exposing the context gate to the Netlify front end."""

import logging
import os
import time
from collections import defaultdict, deque

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

from agent import assess, build_agent
from models import ContextAssessment, IncidentDraft

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("context-gate")

app = FastAPI(title="Incident Context Gate (demo)", version="0.1.0")

# Netlify proxies /api/* here, so browsers normally never call this origin directly.
# ALLOWED_ORIGINS is only needed if you point the front end straight at this service.
origins = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "").split(",") if o.strip()]
if origins:
    app.add_middleware(
        CORSMiddleware, allow_origins=origins, allow_methods=["GET", "POST"], allow_headers=["Content-Type"]
    )

agent = build_agent()

# A public demo URL calls a paid API, so cap requests per client.
RATE_LIMIT = int(os.getenv("RATE_LIMIT_PER_10_MIN", "20"))
_hits: dict[str, deque[float]] = defaultdict(deque)


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _check_rate_limit(ip: str) -> None:
    now = time.monotonic()
    window = _hits[ip]
    while window and now - window[0] > 600:
        window.popleft()
    if len(window) >= RATE_LIMIT:
        raise HTTPException(429, "Too many checks from this connection. Wait a few minutes and try again.")
    window.append(now)


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "model": os.getenv("MODEL", "ollama:qwen3.5:9b")}


@app.post("/api/assess", response_model=ContextAssessment)
async def assess_incident(draft: IncidentDraft, request: Request) -> ContextAssessment:
    _check_rate_limit(_client_ip(request))
    try:
        return await assess(agent, draft)
    except Exception:  # surface a clean error; details stay in the server log
        log.exception("Assessment failed")
        raise HTTPException(502, "The context check could not complete. Try again in a moment.")
