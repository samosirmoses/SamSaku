"""Shared pooled HTTP client for external integrations (Gemini, Telegram, Storage)."""
import threading

import httpx

_lock = threading.Lock()
_client: httpx.Client | None = None


def get_http_client() -> httpx.Client:
    global _client
    if _client is not None and not _client.is_closed:
        return _client
    with _lock:
        if _client is None or _client.is_closed:
            _client = httpx.Client(
                timeout=httpx.Timeout(30.0, connect=10.0),
                limits=httpx.Limits(max_connections=10, max_keepalive_connections=4),
                follow_redirects=False,
            )
        return _client


def close_http_client() -> None:
    global _client
    with _lock:
        if _client is not None and not _client.is_closed:
            _client.close()
        _client = None
