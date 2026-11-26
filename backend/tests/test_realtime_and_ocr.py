"""Tests for native WebSocket realtime sync and Gemini Vision / Tesseract receipt OCR."""
from io import BytesIO
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app import ocr
from app.db import Base, get_db
from app.main import app


def _tiny_png_bytes() -> bytes:
    buf = BytesIO()
    Image.new("RGB", (80, 80), color=(255, 255, 255)).save(buf, format="PNG")
    return buf.getvalue()


def test_websocket_auth_and_broadcast(monkeypatch):
    test_engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    Base.metadata.create_all(test_engine)

    def sessions():
        with Session(test_engine, expire_on_commit=False) as db:
            yield db

    app.dependency_overrides[get_db] = sessions
    monkeypatch.setenv("SAMSAKU_DEV_TOKEN", "ws-secret-123")
    monkeypatch.setenv("SAMSAKU_ENV", "test")
    try:
        with TestClient(app) as client:
            with client.websocket_connect("/v1/ws") as ws:
                ws.send_json({"type": "auth", "dev_token": "ws-secret-123"})
                assert ws.receive_json() == {"type": "connected"}

                ws.send_json({"type": "ping"})
                assert ws.receive_json() == {"type": "pong"}

                # Triggering an API mutation must push a realtime sync event to the connected socket
                res = client.post(
                    "/v1/accounts",
                    headers={"X-Dev-Token": "ws-secret-123"},
                    json={"name": "Dompet WS", "kind": "bank"},
                )
                assert res.status_code == 201
                msg = ws.receive_json()
                assert msg["type"] == "sync"
                assert msg["event"] == "account:created"
    finally:
        app.dependency_overrides.clear()


def test_websocket_rejects_bad_token(monkeypatch):
    monkeypatch.setenv("SAMSAKU_DEV_TOKEN", "ws-secret-123")
    monkeypatch.setenv("SAMSAKU_ENV", "test")
    with TestClient(app) as client:
        with client.websocket_connect("/v1/ws") as ws:
            ws.send_json({"type": "auth", "dev_token": "wrong-token"})
            try:
                ws.receive_json()
                assert False, "Expected WebSocket to close on bad token"
            except Exception:
                pass


def test_gemini_vision_receipt_parsing_and_formatting(monkeypatch):
    monkeypatch.setenv("SAMSAKU_DEV_TOKEN", "ocr-secret")
    monkeypatch.setenv("SAMSAKU_ENV", "development")
    monkeypatch.setenv("GEMINI_API_KEY", "fake-key")

    class _FakeResp:
        status_code = 200
        text = ""

        def json(self):
            return {
                "candidates": [
                    {
                        "content": {
                            "parts": [
                                {
                                    "text": '{"merchant":"Indomaret","items":["Susu Ultra","Roti Tawar"],"amount":32500,"date":"2026-11-26","category":"Belanja & Kebutuhan"}'
                                }
                            ]
                        }
                    }
                ]
            }

    class _FakeClient:
        def __init__(self, *a, **kw):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, *a, **kw):
            return _FakeResp()

    with patch.object(ocr.httpx, "Client", _FakeClient):
        parsed = ocr._scan_with_gemini(_tiny_png_bytes(), ["Makan & Minum", "Belanja & Kebutuhan"])
        assert parsed is not None
        assert parsed["merchant"] == "Indomaret"
        assert parsed["items"] == ["Susu Ultra", "Roti Tawar"]
        assert parsed["amount"] == 32500
        assert parsed["date"] == "2026-11-26"
        assert parsed["category_hint"] == "Belanja & Kebutuhan"
        assert parsed["engine"] == "gemini"
        assert ocr._format_description(parsed["merchant"], parsed["items"]) == "Indomaret — Susu Ultra, Roti Tawar"
