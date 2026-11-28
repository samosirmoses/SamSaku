"""One private ledger through the actual API, including Telegram, bootstrap, and report download."""
import csv
import io
import json
import os
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core.db import Base, get_db, normalize_url
from app.main import app


def test_capture_to_report(monkeypatch, tmp_path):
    test_url = os.environ.get("SAMSAKU_TEST_POSTGRES")
    engine = (
        create_engine(normalize_url(test_url))
        if test_url
        else create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    )
    if not test_url:
        Base.metadata.create_all(engine)
    user = str(uuid4())
    for key, value in {
        "OWNER_ID": user,
        "SAMSAKU_ENV": "development",
        "SAMSAKU_DEV_TOKEN": "local-sample",
        "TELEGRAM_WEBHOOK_SECRET": "test-webhook",
        "TELEGRAM_USER_ID": "42",
        "BCA_TOKEN": "test-bca",
    }.items():
        monkeypatch.setenv(key, value)

    def sessions():
        with Session(engine, expire_on_commit=False) as db:
            yield db

    app.dependency_overrides[get_db] = sessions
    local = {"X-Dev-Token": "local-sample"}
    webhook = {"X-Telegram-Bot-Api-Secret-Token": "test-webhook"}
    update = {
        "update_id": 101,
        "message": {
            "date": 1735725600,
            "from": {"id": 42},
            "chat": {"id": 42, "type": "private"},
            "text": "kopi 35k tunai",
        },
    }
    try:
        with TestClient(app) as client:
            assert client.get("/v1/accounts").status_code == 401
            account = client.post(
                "/v1/accounts",
                headers=local,
                json={"name": "Tunai", "code": "CASH", "opening_date": "2025-01-01", "opening_balance": 100000},
            )
            assert account.status_code == 201
            assert client.post("/v1/webhooks/telegram", json=update).status_code == 403
            first = client.post("/v1/webhooks/telegram", headers=webhook, json=update).json()
            replay = client.post("/v1/webhooks/telegram", headers=webhook, json=update).json()
            assert first == replay
            assert "✓ Tercatat" in first["text"]
            assert "Saldo Tunai: Rp65.000" in first["text"]
            buttons = first["reply_markup"]["inline_keyboard"][0]
            assert [b["text"] for b in buttons] == ["Ganti Kategori", "Ganti Dompet", "Hapus"]
            assert len(client.get("/v1/transactions", headers=local).json()) == 1
            period = {"start": "2025-01-01", "end": "2025-01-31"}
            report = client.get("/v1/summary", params=period, headers=local).json()
            assert report["expense"] == 35000 and len(report["transactions"]) == 1

            # Consolidated single-request bootstrap must match summary and accounts
            boot = client.get("/v1/bootstrap", params={"month": "2025-01"}, headers=local)
            assert boot.status_code == 200
            boot_data = boot.json()
            assert boot_data["month"] == "2025-01"
            assert boot_data["summary"]["expense"] == 35000
            assert len(boot_data["transactions"]) == 1
            assert boot_data["accounts"][0]["balance"] == 65000
            assert boot_data["accounts"][0]["tx_count"] == 1

            cutoff = client.get("/v1/summary", params={"end": "2025-01-31"}, headers=local).json()
            assert cutoff["start"] == "2025-01-01" and cutoff["expense"] == 35000
            assert client.get("/v1/accounts", headers=local).json()[0]["balance"] == 65000
            data = client.get("/v1/reports/csv", params=period, headers=local)
            rows = list(csv.DictReader(io.StringIO(data.content.decode("utf-8-sig"))))
            assert len(rows) == 1 and int(rows[0]["Pengeluaran bersih (IDR)"]) == 35000
            pdf = client.get("/v1/reports/pdf", params=period, headers=local)
            assert pdf.status_code == 200 and pdf.content.startswith(b"%PDF-")
            assert (
                client.post(
                    "/v1/accounts",
                    headers=local,
                    json={"name": "myBCA", "code": "BCA", "opening_date": "2025-01-01", "opening_balance": 500000},
                ).status_code
                == 201
            )
            rules = tmp_path / "fixture.json"
            rules.write_text(
                json.dumps(
                    [
                        {
                            "source": "bca",
                            "account_code": "BCA",
                            "verified": True,
                            "kind": "expense",
                            "date_format": "%Y-%m-%d",
                            "pattern": r"Contoh berhasil (?P<date>[0-9-]+) Rp(?P<amount>[0-9.]+) (?P<merchant>.+) ref (?P<ref>\w+)",
                        }
                    ]
                ),
                encoding="utf-8",
            )
            monkeypatch.setenv("SAMSAKU_PARSER_RULES", str(rules))
            mail = {
                "external_id": "fixture-01",
                "text": "Contoh berhasil 2025-01-15 Rp12.000 Toko contoh ref A1",
                "occurred_at": "2025-02-01T08:00:00+07:00",
            }
            evidence_headers = {"Authorization": "Bearer test-bca"}
            responses = [client.post("/v1/events/bca", headers=evidence_headers, json=mail) for _ in range(2)]
            assert all(r.status_code == 200 for r in responses)
            assert responses[0].json()["transaction_id"] == responses[1].json()["transaction_id"]
            summary = client.get("/v1/summary", params=period, headers=local).json()
            assert summary["expense"] == 47000 and len(summary["transactions"]) == 2
            assert client.get("/v1/reports/pdf", params=period, headers=local).content.startswith(b"%PDF-")
    finally:
        del app.dependency_overrides[get_db]
        engine.dispose()
