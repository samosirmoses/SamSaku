"""Tests for native WebSocket realtime sync and Gemini Vision-only receipt scanning."""
from io import BytesIO
from unittest.mock import patch

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core.db import Base, get_db
from app.main import app
from app.services import ocr


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
        def post(self, *a, **kw):
            return _FakeResp()

    with patch.object(ocr, "get_http_client", return_value=_FakeClient()):
        parsed = ocr._scan_with_gemini(_tiny_png_bytes(), ["Makan & Minum", "Belanja & Kebutuhan"])
        assert parsed is not None
        assert parsed["merchant"] == "Indomaret"
        assert parsed["items"] == ["Susu Ultra", "Roti Tawar"]
        assert parsed["amount"] == 32500
        assert parsed["date"] == "2026-11-26"
        assert parsed["category_hint"] == "Belanja & Kebutuhan"
        assert parsed["engine"] == "gemini"
        assert ocr._format_description(parsed["merchant"], parsed["items"]) == "Indomaret — Susu Ultra, Roti Tawar"


def test_receipt_scan_requires_gemini_key(monkeypatch):
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.setenv("SAMSAKU_ENV", "development")
    with Session(engine) as db:
        with pytest.raises(HTTPException) as err:
            ocr.scan_receipt_auto(db, "owner-1", "struk.png", _tiny_png_bytes())
        assert err.value.status_code == 503
        assert "GEMINI_API_KEY" in err.value.detail


def test_parse_positive_int_mybca_and_indonesian_formats():
    assert ocr._parse_positive_int("IDR 32,000.00") == 32000
    assert ocr._parse_positive_int("Rp 150.000,00") == 150000
    assert ocr._parse_positive_int("1,250,000.00") == 1250000
    assert ocr._parse_positive_int("Rp45.000") == 45000
    assert ocr._parse_positive_int(32000) == 32000
    assert ocr._parse_positive_int(32000.0) == 32000


def test_account_number_crud_and_shared_ewallet_phone(monkeypatch):
    test_engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    Base.metadata.create_all(test_engine)

    def sessions():
        with Session(test_engine, expire_on_commit=False) as db:
            yield db

    app.dependency_overrides[get_db] = sessions
    monkeypatch.setenv("SAMSAKU_DEV_TOKEN", "acc-secret")
    monkeypatch.setenv("SAMSAKU_ENV", "test")
    headers = {"X-Dev-Token": "acc-secret"}
    try:
        with TestClient(app) as client:
            r1 = client.post(
                "/v1/accounts",
                headers=headers,
                json={"name": "GoPay", "kind": "ewallet", "account_number": "0812-3456-7890"},
            )
            assert r1.status_code == 201
            assert r1.json()["account_number"] == "081234567890"

            # Same phone number allowed on OVO
            r2 = client.post(
                "/v1/accounts",
                headers=headers,
                json={"name": "OVO", "kind": "ewallet", "account_number": "0812 3456 7890"},
            )
            assert r2.status_code == 201
            assert r2.json()["account_number"] == "081234567890"

            # Short/invalid number rejected
            bad = client.post(
                "/v1/accounts",
                headers=headers,
                json={"name": "Invalid", "kind": "bank", "account_number": "123"},
            )
            assert bad.status_code == 422

            # PATCH can clear account_number
            cleared = client.patch(
                f"/v1/accounts/{r2.json()['id']}",
                headers=headers,
                json={"account_number": ""},
            )
            assert cleared.status_code == 200
            assert cleared.json()["account_number"] is None
    finally:
        app.dependency_overrides.clear()
        test_engine.dispose()


def test_receipt_matching_bca_masked_va_transfer_income_expense():
    from types import SimpleNamespace
    from app.services.receipt_matching import resolve_receipt_classification

    bca1 = SimpleNamespace(id="a-bca1", code="BCA", name="myBCA Utama", kind="bank", account_number="1234567890")
    bca2 = SimpleNamespace(id="a-bca2", code="BCA-TAB", name="BCA Tabungan", kind="bank", account_number="9988776655")
    gopay = SimpleNamespace(id="a-gp", code="GOPAY", name="GoPay", kind="ewallet", account_number="081234567890")
    ovo = SimpleNamespace(id="a-ovo", code="OVO", name="OVO", kind="ewallet", account_number="081234567890")
    accounts = [bca1, bca2, gopay, ovo]

    # 1. Masked m-BCA source -> own BCA Tabungan => transfer with separated fee
    res_tf = resolve_receipt_classification(
        {
            "transaction_type": "Transfer ke BCA",
            "direction": "transfer",
            "merchant": "Tabungan Sendiri",
            "note": "Sisihkan gaji",
            "amount": 500000,
            "fee": 0,
            "total_amount": 500000,
            "source_bank": "BCA",
            "source_account_no": "***7890",
            "target_bank": "BCA",
            "target_account_no": "9988776655",
        },
        accounts,
        default_account_id="a-bca1",
    )
    assert res_tf["kind"] == "transfer"
    assert res_tf["account_id"] == "a-bca1"
    assert res_tf["to_account_id"] == "a-bca2"
    assert res_tf["amount"] == 500000
    assert res_tf["fee"] == 0
    assert res_tf["description"] == "Tabungan Sendiri — Sisihkan gaji"
    assert res_tf["source_account_masked"] == "****7890"

    # 2. BCA Virtual Account top-up GoPay vs OVO with shared phone number
    res_gp = resolve_receipt_classification(
        {
            "transaction_type": "BCA Virtual Account",
            "direction": "transfer",
            "merchant": "GOPAY",
            "amount": 200000,
            "fee": 1000,
            "total_amount": 201000,
            "source_bank": "BCA",
            "source_account_no": "1234567890",
            "target_bank": "BCA Virtual Account",
            "target_account_no": "70001081234567890",
        },
        accounts,
        default_account_id="a-bca1",
    )
    assert res_gp["kind"] == "transfer"
    assert res_gp["account_id"] == "a-bca1"
    assert res_gp["to_account_id"] == "a-gp"
    assert res_gp["amount"] == 200000
    assert res_gp["fee"] == 1000

    res_ovo = resolve_receipt_classification(
        {
            "transaction_type": "BCA Virtual Account",
            "direction": "transfer",
            "merchant": "OVO",
            "amount": 100000,
            "fee": 1000,
            "total_amount": 101000,
            "source_bank": "BCA",
            "source_account_no": "1234567890",
            "target_bank": "BCA Virtual Account",
            "target_account_no": "39358081234567890",
        },
        accounts,
        default_account_id="a-bca1",
    )
    assert res_ovo["kind"] == "transfer"
    assert res_ovo["to_account_id"] == "a-ovo"

    # 3. Incoming transfer from foreign account to own BCA => income
    res_inc = resolve_receipt_classification(
        {
            "transaction_type": "Transfer Masuk",
            "direction": "income",
            "merchant": "PT Maju Jaya",
            "note": "Bonus proyek",
            "amount": 1500000,
            "fee": 0,
            "total_amount": 1500000,
            "source_bank": "Mandiri",
            "source_account_no": "1300099988877",
            "target_bank": "BCA",
            "target_account_no": "1234567890",
        },
        accounts,
        default_account_id="a-bca1",
    )
    assert res_inc["kind"] == "income"
    assert res_inc["account_id"] == "a-bca1"
    assert res_inc["to_account_id"] is None

    # 4. Transfer to foreign account (BI-FAST) => expense with total (amount + fee) and berita description
    res_exp = resolve_receipt_classification(
        {
            "transaction_type": "BI-FAST",
            "direction": "transfer",
            "merchant": "Budi Santoso",
            "note": "Patungan makan siang",
            "amount": 100000,
            "fee": 2500,
            "total_amount": 102500,
            "source_bank": "BCA",
            "source_account_no": "1234567890",
            "target_bank": "Mandiri",
            "target_account_no": "1400011223344",
        },
        accounts,
        default_account_id="a-bca1",
    )
    assert res_exp["kind"] == "expense"
    assert res_exp["account_id"] == "a-bca1"
    assert res_exp["amount"] == 102500
    assert res_exp["fee"] == 0
    assert res_exp["description"] == "Budi Santoso — Patungan makan siang"

    # 5. Ambiguous source (2 BCA accounts, source_account_no missing) => fallback default with account_guessed=True
    res_amb = resolve_receipt_classification(
        {
            "transaction_type": "QRIS",
            "direction": "expense",
            "merchant": "Kopi Tuku",
            "amount": 35000,
            "fee": 0,
            "total_amount": 35000,
            "source_bank": "BCA",
        },
        accounts,
        default_account_id="a-bca1",
    )
    assert res_amb["kind"] == "expense"
    assert res_amb["account_id"] == "a-bca1"
    assert res_amb["account_guessed"] is True

    # 6. Real myBCA QRIS middle-masked source format: "883 - 2** - **41"
    xpresi = SimpleNamespace(id="a-xpresi", code="BCA-XPRESI", name="Tahapan Xpresi", kind="bank", account_number="8832123441")
    res_qris = resolve_receipt_classification(
        {
            "transaction_type": "Pembayaran QRIS",
            "direction": "expense",
            "merchant": "RMU RESTO ON TRAIN N 1",
            "amount": 59000,
            "fee": 0,
            "total_amount": 59000,
            "source_bank": "BCA",
            "source_account_no": "883 - 2** - **41",
            "target_bank": None,
            "target_account_no": None,
        },
        [bca1, xpresi, gopay],
        default_account_id="a-bca1",
    )
    assert res_qris["kind"] == "expense"
    assert res_qris["account_id"] == "a-xpresi"
    assert res_qris["account_guessed"] is False
    assert res_qris["description"] == "RMU RESTO ON TRAIN N 1 (Pembayaran QRIS)"


def test_telegram_photo_bca_transfer_end_to_end(monkeypatch):
    from uuid import uuid4
    from sqlalchemy import select
    from app.models import Evidence
    from app.routers import telegram as tg_router

    test_engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    Base.metadata.create_all(test_engine)

    def sessions():
        with Session(test_engine, expire_on_commit=False) as db:
            yield db

    app.dependency_overrides[get_db] = sessions
    for k, v in {
        "OWNER_ID": str(uuid4()),
        "SAMSAKU_ENV": "development",
        "SAMSAKU_DEV_TOKEN": "tg-dev-tok",
        "TELEGRAM_WEBHOOK_SECRET": "tg-sec",
        "TELEGRAM_USER_ID": "99",
        "GEMINI_API_KEY": "fake-key",
    }.items():
        monkeypatch.setenv(k, v)

    headers = {"X-Dev-Token": "tg-dev-tok"}
    wh_headers = {"X-Telegram-Bot-Api-Secret-Token": "tg-sec"}

    fake_ai = {
        "transaction_type": "BCA Virtual Account",
        "direction": "transfer",
        "merchant": "GOPAY",
        "note": None,
        "items": [],
        "amount": 500000,
        "fee": 1000,
        "total_amount": 501000,
        "amount_options": [500000, 501000],
        "date": "2026-11-27",
        "category_hint": None,
        "account_hint": "BCA",
        "source_bank": "BCA",
        "source_account_no": "1234567890",
        "target_bank": "BCA Virtual Account",
        "target_account_no": "70001081234567890",
        "engine": "gemini",
        "raw_text": "BCA Virtual Account GOPAY",
    }

    try:
        with TestClient(app) as client:
            bca = client.post(
                "/v1/accounts",
                headers=headers,
                json={
                    "name": "myBCA",
                    "code": "BCA",
                    "kind": "bank",
                    "account_number": "1234567890",
                    "opening_date": "2026-01-01",
                    "opening_balance": 2000000,
                },
            ).json()
            gp = client.post(
                "/v1/accounts",
                headers=headers,
                json={
                    "name": "GoPay",
                    "code": "GOPAY",
                    "kind": "ewallet",
                    "account_number": "081234567890",
                    "opening_date": "2026-01-01",
                    "opening_balance": 100000,
                },
            ).json()

            photo_update = {
                "update_id": 501,
                "message": {
                    "date": 1795651200,
                    "from": {"id": 99},
                    "chat": {"id": 99, "type": "private"},
                    "photo": [{"file_id": "file-abc", "width": 800, "file_size": 1024}],
                },
            }

            with patch.object(tg_router, "download_photo", return_value=_tiny_png_bytes()), patch.object(
                ocr, "_scan_with_gemini", return_value=fake_ai
            ):
                res = client.post("/v1/webhooks/telegram", headers=wh_headers, json=photo_update)
                assert res.status_code == 200, res.text
                body = res.json()
                assert "✓ Tercatat" in body["text"]
                assert "⇄ Transfer Rp500.000 (+admin Rp1.000)" in body["text"]
                assert "myBCA → GoPay" in body["text"]
                assert "Saldo myBCA: Rp1.499.000 · GoPay: Rp600.000" in body["text"]
                row_btns = body["reply_markup"]["inline_keyboard"][0]
                assert [b["text"] for b in row_btns] == ["Ganti Dompet", "Hapus"]

            # Verify raw account numbers are masked in source_events and transaction is posted
            with Session(test_engine) as db:
                ev = db.scalar(select(Evidence).where(Evidence.source == "receipt"))
                assert ev is not None
                assert ev.status == "posted"
                assert ev.parsed["source_account_masked"] == "****7890"
                assert ev.parsed["target_account_masked"] == "****7890"
                assert "1234567890" not in str(ev.parsed)

            accs = {a["id"]: a["balance"] for a in client.get("/v1/accounts", headers=headers).json()}
            assert accs[bca["id"]] == 2000000 - 501000
            assert accs[gp["id"]] == 100000 + 500000
    finally:
        app.dependency_overrides.clear()
        test_engine.dispose()
