"""SamSaku FastAPI application bootstrap."""
import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.exc import IntegrityError

from .core.config import cors_origins
from .core.http_client import close_http_client
from .core.realtime import hub as realtime_hub, router as realtime_router
from .routers import (
    accounts_router,
    bootstrap_router,
    budgets_router,
    categories_router,
    planning_router,
    reviews_router,
    start_telegram_poller_if_enabled,
    summary_router,
    telegram_router,
    tools_router,
    transactions_router,
)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    realtime_hub.bind_loop(asyncio.get_running_loop())
    start_telegram_poller_if_enabled()
    try:
        yield
    finally:
        close_http_client()


app = FastAPI(title="SamSaku", version="2.0.0", lifespan=lifespan)

app.add_middleware(GZipMiddleware, minimum_size=1024)
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins(),
    allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE"],
    allow_headers=["Content-Type", "Authorization", "X-Dev-Token", "Idempotency-Key"],
)


@app.middleware("http")
async def private_cache(request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/v1/"):
        response.headers["Cache-Control"] = "private, no-store"
    return response


@app.exception_handler(IntegrityError)
async def conflict(_request, _exc):
    return JSONResponse(
        status_code=409,
        content={"detail": "Kode, referensi, atau relasi data telah berubah. Muat ulang."},
    )


@app.get("/health", tags=["health"])
def health():
    return {"status": "ok"}


for _router in (
    bootstrap_router,
    accounts_router,
    categories_router,
    transactions_router,
    budgets_router,
    summary_router,
    reviews_router,
    planning_router,
    tools_router,
    telegram_router,
    realtime_router,
):
    app.include_router(_router)
