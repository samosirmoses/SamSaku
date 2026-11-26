"""Application configuration and environment helpers."""
import os
from zoneinfo import ZoneInfo

JAKARTA = ZoneInfo("Asia/Jakarta")
DEFAULT_OWNER_ID = "00000000-0000-4000-8000-000000000001"
DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite"


def app_env() -> str:
    return os.getenv("SAMSAKU_ENV", "development").strip().lower()


def is_production() -> bool:
    return app_env() == "production"


def is_test_env() -> bool:
    return app_env() == "test"


def cors_origins() -> list[str]:
    raw = os.getenv("CORS_ORIGINS", "*").strip()
    if raw == "*":
        return ["*"]
    origins = [item.strip() for item in raw.split(",") if item.strip()]
    return origins or ["*"]


def gemini_api_key() -> str:
    return (os.getenv("GEMINI_API_KEY") or "").strip()


def gemini_model() -> str:
    return (os.getenv("GEMINI_MODEL") or DEFAULT_GEMINI_MODEL).strip()
