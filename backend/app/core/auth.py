"""Authentication helpers for Supabase JWKS JWT and local/self-hosted dev token."""
import os
import secrets
from functools import lru_cache
from uuid import UUID

import jwt
from fastapi import Header, HTTPException
from jwt import PyJWKClient

from .config import DEFAULT_OWNER_ID


def configured_owner() -> str:
    raw = os.getenv("OWNER_ID", "").strip()
    if not raw:
        return DEFAULT_OWNER_ID
    try:
        return str(UUID(raw))
    except ValueError:
        raise HTTPException(503, "Pemilik aplikasi belum dikonfigurasi.")


def secret_matches(actual: str, name: str) -> bool:
    expected = os.getenv(name)
    return bool(actual and expected and secrets.compare_digest(actual.encode(), expected.encode()))


@lru_cache(maxsize=2)
def jwks(url: str) -> PyJWKClient:
    return PyJWKClient(url + "/auth/v1/.well-known/jwks.json", timeout=5)


def verify_owner(authorization: str = "", x_dev_token: str = "") -> str:
    user_id = configured_owner()
    if (os.getenv("SAMSAKU_ENV") != "production" or not os.getenv("OWNER_ID")) and secret_matches(
        x_dev_token, "SAMSAKU_DEV_TOKEN"
    ):
        return user_id
    base = os.getenv("SUPABASE_URL", "").rstrip("/")
    if not authorization.startswith("Bearer ") or not base.startswith("https://"):
        raise HTTPException(401, "Silakan masuk dengan akun pemilik.")
    token = authorization[7:]
    try:
        key = jwks(base).get_signing_key_from_jwt(token).key
        claims = jwt.decode(
            token,
            key,
            algorithms=["ES256", "RS256"],
            audience="authenticated",
            issuer=base + "/auth/v1",
            options={"require": ["sub", "exp", "aud", "iss"]},
        )
    except (jwt.PyJWTError, ValueError):
        raise HTTPException(401, "Sesi kedaluwarsa atau tidak valid.")
    if claims["sub"] != user_id:
        raise HTTPException(403, "Akun ini tidak memiliki akses.")
    return user_id


def owner(authorization: str = Header(""), x_dev_token: str = Header("")) -> str:
    return verify_owner(authorization=authorization, x_dev_token=x_dev_token)
