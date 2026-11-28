"""Lightweight memory-bounded sliding-window rate limiter for webhooks and auth bursts."""
from collections import deque
import os
import threading
import time

from fastapi import Request


class SlidingWindowLimiter:
    """In-memory per-key sliding-window counter with strict key cap for low-RAM VPS hosts."""

    def __init__(self, *, window_seconds: int = 60, max_keys: int = 2048) -> None:
        self.window_seconds = window_seconds
        self.max_keys = max_keys
        self._lock = threading.Lock()
        self._buckets: dict[str, deque[float]] = {}

    def _prune(self, key: str, now: float) -> deque[float] | None:
        bucket = self._buckets.get(key)
        if not bucket:
            return None
        cutoff = now - self.window_seconds
        while bucket and bucket[0] <= cutoff:
            bucket.popleft()
        if not bucket:
            self._buckets.pop(key, None)
            return None
        return bucket

    def is_limited(self, key: str, limit: int, *, now: float | None = None) -> tuple[bool, int]:
        """Check whether `key` currently meets or exceeds `limit` without recording."""
        if limit <= 0:
            return False, 0
        ts = time.monotonic() if now is None else now
        with self._lock:
            bucket = self._prune(key, ts)
            if not bucket or len(bucket) < limit:
                return False, 0
            retry_after = max(1, int(bucket[0] + self.window_seconds - ts) + 1)
            return True, retry_after

    def hit(self, key: str, limit: int, *, now: float | None = None) -> tuple[bool, int]:
        """Record one hit for `key` and return (limited, retry_after_seconds)."""
        if limit <= 0:
            return False, 0
        ts = time.monotonic() if now is None else now
        with self._lock:
            bucket = self._prune(key, ts)
            if bucket and len(bucket) >= limit:
                retry_after = max(1, int(bucket[0] + self.window_seconds - ts) + 1)
                return True, retry_after
            if bucket is None:
                if len(self._buckets) >= self.max_keys:
                    oldest_key = next(iter(self._buckets))
                    self._buckets.pop(oldest_key, None)
                bucket = deque()
                self._buckets[key] = bucket
            bucket.append(ts)
            return False, 0

    def reset(self) -> None:
        with self._lock:
            self._buckets.clear()


webhook_limiter = SlidingWindowLimiter(window_seconds=60)
auth_fail_limiter = SlidingWindowLimiter(window_seconds=60)


def webhook_rate_limit() -> int:
    raw = os.getenv("SAMSAKU_RATE_LIMIT_WEBHOOK_PER_MIN", "60").strip()
    return max(1, int(raw)) if raw.isdigit() else 60


def auth_fail_rate_limit() -> int:
    raw = os.getenv("SAMSAKU_RATE_LIMIT_AUTH_FAIL_PER_MIN", "30").strip()
    return max(1, int(raw)) if raw.isdigit() else 30


def client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "").strip()
    if forwarded:
        return forwarded.split(",")[0].strip() or "unknown"
    real_ip = request.headers.get("x-real-ip", "").strip()
    if real_ip:
        return real_ip
    return request.client.host if request.client and request.client.host else "unknown"


def reset_rate_limiters() -> None:
    webhook_limiter.reset()
    auth_fail_limiter.reset()
