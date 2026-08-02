"""FastAPI + SSE streaming service for Arforge Agent (T35).

This opt-in provider proxy is disabled by default. It exposes raw provider
chat, not the workspace agent runtime, and must not be deployed or described as
the full code-agent API. Operators must explicitly enable both the HTTP surface
and raw-model proxy and configure a strong bearer token.

Available routes:
  - POST /chat — synchronous chat (non-streaming)
  - POST /chat/stream — Server-Sent Events streaming
  - GET /health — health check
  - GET /providers — list available model providers
  - restrictive CORS, bearer authentication, request validation
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import time
import uuid
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

logger = logging.getLogger("arforge.api")

# ── Models ───────────────────────────────────────────────────────────


class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=10000)
    provider: str = Field(default="")
    stream: bool = Field(default=False)
    session_id: str | None = Field(default=None)


class ChatResponse(BaseModel):
    answer: str
    session_id: str
    model: str
    provider: str
    tokens_used: int = 0
    elapsed_ms: float = 0.0


class HealthResponse(BaseModel):
    status: str
    version: str
    api_enabled: bool
    authentication_required: bool = True


# ── Lifespan ─────────────────────────────────────────────────────────


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Report disabled/misconfigured state without exposing credentials."""
    if not _api_enabled():
        logger.info("HTTP provider proxy is disabled")
        yield
        return
    if not _api_token():
        logger.error("HTTP provider proxy enabled without a valid ARFORGE_API_TOKEN")
        yield
        return
    from arforge.models.model_factory import list_available_providers

    available = list_available_providers()
    if not any(available.values()):
        logger.warning("No model provider API keys configured")
    else:
        configured = [k for k, v in available.items() if v]
        logger.info("Providers available: %s", ", ".join(configured))
    yield


# ── App ──────────────────────────────────────────────────────────────

app = FastAPI(
    title="Arforge Agent API",
    description="Opt-in authenticated raw-provider proxy; not the workspace agent runtime",
    version="1.0.0",
    lifespan=lifespan,
)

def _cors_origins() -> list[str]:
    return [item.strip() for item in os.getenv("ARFORGE_API_CORS_ORIGINS", "").split(",") if item.strip()]


app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(),
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
)


_TRUE_VALUES = {"1", "true", "yes", "on"}


def _api_enabled() -> bool:
    return os.getenv("ARFORGE_ENABLE_HTTP_API", "").strip().casefold() in _TRUE_VALUES


def _raw_model_api_enabled() -> bool:
    return os.getenv("ARFORGE_ENABLE_RAW_MODEL_API", "").strip().casefold() in _TRUE_VALUES


def _api_token() -> str:
    token = os.getenv("ARFORGE_API_TOKEN", "").strip()
    return token if len(token) >= 32 else ""


def _require_raw_model_api() -> None:
    if not _raw_model_api_enabled():
        raise HTTPException(status_code=503, detail="Raw model proxy is disabled")


@app.middleware("http")
async def require_bearer_authentication(request: Request, call_next):
    if request.url.path == "/health":
        return await call_next(request)
    if not _api_enabled():
        return JSONResponse(status_code=503, content={"error": "HTTP API is disabled", "code": "API_DISABLED"})
    expected = _api_token()
    if not expected:
        return JSONResponse(status_code=503, content={"error": "HTTP API authentication is not configured", "code": "API_MISCONFIGURED"})
    authorization = request.headers.get("authorization", "")
    scheme, _, supplied = authorization.partition(" ")
    if scheme.casefold() != "bearer" or not supplied or not hmac.compare_digest(supplied, expected):
        return JSONResponse(
            status_code=401,
            content={"error": "Authentication required", "code": "UNAUTHORIZED"},
            headers={"WWW-Authenticate": "Bearer"},
        )
    return await call_next(request)


# ── Routes ───────────────────────────────────────────────────────────


@app.get("/health", response_model=HealthResponse)
async def health():
    """Minimal unauthenticated liveness response."""
    enabled = _api_enabled()
    return HealthResponse(
        status="ok" if enabled and bool(_api_token()) else ("misconfigured" if enabled else "disabled"),
        version=__import__("arforge").__version__,
        api_enabled=enabled,
    )


@app.get("/providers")
async def list_providers():
    """List available model providers and their status."""
    from arforge.models.model_factory import list_available_providers
    return {"providers": list_available_providers()}


@app.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    """Synchronous raw-provider chat; explicitly opt-in and not agentic."""
    _require_raw_model_api()
    from arforge.product.model_config_runtime import ModelConfigError, get_model_config

    session_id = request.session_id or str(uuid.uuid4())[:12]

    try:
        runtime = get_model_config()
        adapter = runtime.create_adapter(request.provider or None)
        provider_id = request.provider.strip().casefold() if request.provider else runtime.get_active_provider()
    except ModelConfigError as exc:
        detail = f"Unsupported model provider: {request.provider}" if exc.code == "UNKNOWN_PROVIDER" else exc.message
        raise HTTPException(status_code=400, detail=detail) from None

    t0 = time.perf_counter()

    try:
        # Use the underlying adapter (unwrap RateLimitedAdapter)
        inner = getattr(adapter, "_adapter", adapter)
        result = inner.generate([
            {"role": "user", "content": request.message}
        ])
    except Exception as e:
        logger.error("Chat error: %s", e, exc_info=True)
        raise HTTPException(status_code=502, detail="Model provider call failed") from None

    elapsed_ms = (time.perf_counter() - t0) * 1000

    return ChatResponse(
        answer=result if isinstance(result, str) else str(result),
        session_id=session_id,
        model=getattr(getattr(adapter, "_adapter", adapter), "model_name", "unknown"),
        provider=provider_id,
        elapsed_ms=round(elapsed_ms, 1),
    )


@app.post("/chat/stream")
async def chat_stream(request: ChatRequest):
    """SSE raw-provider stream; explicitly opt-in and not agentic."""
    _require_raw_model_api()
    from arforge.product.model_config_runtime import ModelConfigError, get_model_config

    session_id = request.session_id or str(uuid.uuid4())[:12]

    try:
        adapter = get_model_config().create_adapter(request.provider or None)
    except ModelConfigError as exc:
        detail = f"Unsupported model provider: {request.provider}" if exc.code == "UNKNOWN_PROVIDER" else exc.message
        raise HTTPException(status_code=400, detail=detail) from None

    inner = getattr(adapter, "_adapter", adapter)

    async def event_stream() -> AsyncGenerator[str, None]:
        t0 = time.perf_counter()
        full_text = ""

        try:
            # Send session start event
            yield f"event: session\ndata: {json.dumps({'session_id': session_id})}\n\n"

            # Stream tokens
            for chunk in inner.stream_generate([
                {"role": "user", "content": request.message}
            ]):
                text = chunk.text if hasattr(chunk, "text") else str(chunk)
                full_text += text
                yield f"data: {json.dumps({'token': text})}\n\n"
                await asyncio.sleep(0)  # yield to event loop

            elapsed_ms = (time.perf_counter() - t0) * 1000

            # Send done event
            yield f"event: done\ndata: {json.dumps({'elapsed_ms': round(elapsed_ms, 1), 'total_chars': len(full_text)})}\n\n"

        except Exception as e:
            logger.error("Stream error: %s", e, exc_info=True)
            yield f"event: error\ndata: {json.dumps({'error': 'Model provider stream failed', 'code': 'PROVIDER_ERROR'})}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ── Error handlers ───────────────────────────────────────────────────


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": exc.detail, "status_code": exc.status_code},
    )


@app.exception_handler(Exception)
async def general_exception_handler(request: Request, exc: Exception):
    logger.error("Unhandled error: %s", exc, exc_info=True)
    return JSONResponse(
        status_code=500,
        content={"error": "Internal server error", "code": "INTERNAL_ERROR"},
    )
