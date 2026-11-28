"""Milestone 1 regression tests: layered boundaries, zero read locks, idempotency, replay conflicts, and bootstrap accuracy."""
import ast
from datetime import date, datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from openpyxl import Workbook
from PIL import Image
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core.db import Base, get_db
from app.main import app
from app.models import Account, Budget, Category, Evidence, Scheme
from app.schemas import TransactionIn
from app.services import ocr
from app.services.jobs import store_file
from app.services.summary import list_budgets
from app.services.transactions import post_transaction

OWNER = "00000000-0000-4000-8000-000000000001"
HEADERS = {"X-Dev-Token": "m1-secret"}


def _make_engine():
    engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})

    @event.listens_for(engine, "connect")
    def _fk(conn, _rec):
        conn.execute("PRAGMA foreign_keys=ON")

    Base.metadata.create_all(engine)
    return engine


def _tiny_png() -> bytes:
    buf = BytesIO()
    Image.new("RGB", (40, 40), color=(255, 255, 255)).save(buf, format="PNG")
    return buf.getvalue()


def _xlsx_bytes() -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = "transactions"
    ws.append(["date", "kind", "amount", "account", "reference"])
    ws.append(["2026-01-10", "expense", 25000, "BCA", "IMP-1"])
    out = BytesIO()
    wb.save(out)
    return out.getvalue()


def test_routers_have_no_direct_orm_queries_or_lock_owner():
    routers_dir = Path(__file__).resolve().parents[1] / "app" / "routers"
    forbidden_calls = {"select", "lock_owner"}
    forbidden_db_attrs = {"add", "delete", "execute", "scalar", "scalars", "get"}
    for path in sorted(routers_dir.glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module and "models" in node.module:
                raise AssertionError(f"{path.name} imports ORM models directly: {node.module}")
            if isinstance(node, ast.Call):
                if isinstance(node.func, ast.Name) and node.func.id in forbidden_calls:
                    raise AssertionError(f"{path.name} calls {node.func.id}() directly")
                if (
                    isinstance(node.func, ast.Attribute)
                    and isinstance(node.func.value, ast.Name)
                    and node.func.value.id == "db"
                    and node.func.attr in forbidden_db_attrs
                ):
                    raise AssertionError(f"{path.name} calls db.{node.func.attr}() directly")


def test_read_endpoints_and_scheme_preview_never_acquire_lock_owner(monkeypatch):
    engine = _make_engine()
    monkeypatch.setenv("OWNER_ID", OWNER)
    monkeypatch.setenv("SAMSAKU_ENV", "development")
    monkeypatch.setenv("SAMSAKU_DEV_TOKEN", "m1-secret")

    with Session(engine) as db:
        db.add(Account(id="acc1", owner_id=OWNER, code="BCA", name="BCA", kind="bank", opening_date=date(2026, 1, 1), opening_balance=1_000_000))
        db.add(Category(id="cat1", owner_id=OWNER, code="FOOD", name="Makan", kind="expense"))
        tx = post_transaction(db, OWNER, TransactionIn(date=date(2026, 1, 5), kind="income", account_id="acc1", amount=500_000))
        db.add(Scheme(id="sch1", owner_id=OWNER, code="S1", name="Skema", cycle_day=1, rules=[{"name": "Simpan", "mode": "remainder", "value": 0, "category_ids": []}]))
        db.commit()
        income_id = tx.id

    def sessions():
        with Session(engine, expire_on_commit=False) as db:
            yield db

    app.dependency_overrides[get_db] = sessions
    lock_calls = []

    def spy_lock(*_a, **_kw):
        lock_calls.append(1)

    try:
        with TestClient(app) as client:
            with (
                patch("app.services.accounts.lock_owner", side_effect=spy_lock),
                patch("app.services.categories.lock_owner", side_effect=spy_lock),
                patch("app.services.transactions.lock_owner", side_effect=spy_lock),
                patch("app.services.summary.lock_owner", side_effect=spy_lock),
                patch("app.services.planning.lock_owner", side_effect=spy_lock),
                patch("app.services.reviews.lock_owner", side_effect=spy_lock),
            ):
                for path in (
                    "/v1/accounts",
                    "/v1/categories",
                    "/v1/transactions",
                    "/v1/summary",
                    "/v1/budgets",
                    "/v1/bootstrap?month=2026-01",
                    "/v1/reviews",
                    "/v1/connections",
                    "/v1/goals",
                    "/v1/schemes",
                ):
                    assert client.get(path, headers=HEADERS).status_code == 200
                prev = client.post(
                    "/v1/schemes/sch1/preview",
                    headers=HEADERS,
                    json={"income_ids": [income_id], "request_id": "req-1", "date": "2026-01-10"},
                )
                assert prev.status_code == 200
                assert lock_calls == []
    finally:
        app.dependency_overrides.clear()
        engine.dispose()


def test_idempotency_key_conflict_replays_and_no_duplicate_broadcasts(monkeypatch):
    engine = _make_engine()
    monkeypatch.setenv("OWNER_ID", OWNER)
    monkeypatch.setenv("SAMSAKU_ENV", "development")
    monkeypatch.setenv("SAMSAKU_DEV_TOKEN", "m1-secret")
    monkeypatch.setenv("BCA_TOKEN", "bca-tok")
    monkeypatch.setenv("GEMINI_API_KEY", "fake-key")

    with Session(engine) as db:
        db.add(Account(id="acc1", owner_id=OWNER, code="BCA", name="BCA", kind="bank", opening_date=date(2026, 1, 1), opening_balance=1_000_000))
        db.add(Category(id="food", owner_id=OWNER, code="FOOD", name="Makan", kind="expense"))
        db.add(Category(id="drink", owner_id=OWNER, code="DRINK", name="Minum", kind="expense"))
        db.add(
            Evidence(
                id="ev-1",
                owner_id=OWNER,
                source="bca",
                external_id="ext-1",
                digest="d1",
                text="Kopi 25rb",
                status="review",
                parsed={},
            )
        )
        db.commit()

    def sessions():
        with Session(engine, expire_on_commit=False) as db:
            yield db

    app.dependency_overrides[get_db] = sessions
    events = []

    def spy_notify(owner_id, ev_name, message=""):
        events.append(ev_name)

    try:
        with TestClient(app) as client:
            with (
                patch("app.routers.transactions.realtime_notify", side_effect=spy_notify),
                patch("app.routers.reviews.realtime_notify", side_effect=spy_notify),
                patch("app.routers.tools.realtime_notify", side_effect=spy_notify),
            ):
                # 1. Idempotency-Key header on POST /v1/transactions + retry broadcast suppression + 409 conflict
                tx_body = {
                    "date": "2026-01-10",
                    "kind": "expense",
                    "account_id": "acc1",
                    "amount": 50_000,
                    "splits": [{"category_id": "food", "amount": 30_000}, {"category_id": "drink", "amount": 20_000}],
                }
                r1 = client.post("/v1/transactions", headers={**HEADERS, "Idempotency-Key": "idem-tx-1"}, json=tx_body)
                assert r1.status_code == 201
                r2 = client.post("/v1/transactions", headers={**HEADERS, "Idempotency-Key": "idem-tx-1"}, json=tx_body)
                assert r2.status_code == 201 and r2.json()["id"] == r1.json()["id"]
                assert events == ["transaction:created"]
                bad_tx = {**tx_body, "amount": 60_000, "splits": [{"category_id": "food", "amount": 60_000}]}
                assert client.post("/v1/transactions", headers={**HEADERS, "Idempotency-Key": "idem-tx-1"}, json=bad_tx).status_code == 409

                # 2. Refund retry with empty splits vs explicit splits -> 409 on mismatch, 201 on exact replay
                parent_id = r1.json()["id"]
                refund_body = {
                    "date": "2026-01-11",
                    "kind": "refund",
                    "account_id": "acc1",
                    "amount": 20_000,
                    "original_id": parent_id,
                    "category_id": "food",
                }
                rf1 = client.post("/v1/transactions", headers={**HEADERS, "Idempotency-Key": "idem-rf-1"}, json=refund_body)
                assert rf1.status_code == 201
                rf_same = client.post("/v1/transactions", headers={**HEADERS, "Idempotency-Key": "idem-rf-1"}, json=refund_body)
                assert rf_same.status_code == 201 and rf_same.json()["id"] == rf1.json()["id"]
                rf_mismatch = {**refund_body, "category_id": None, "splits": []}
                assert client.post("/v1/transactions", headers={**HEADERS, "Idempotency-Key": "idem-rf-1"}, json=rf_mismatch).status_code == 409

                # 3. /v1/events/{source} duplicate retry suppresses duplicate broadcast
                events.clear()
                ev_payload = {"external_id": "bca-dup-1", "text": "Transfer keluar Rp 12.000"}
                e1 = client.post("/v1/events/bca", headers={"Authorization": "Bearer bca-tok"}, json=ev_payload)
                e2 = client.post("/v1/events/bca", headers={"Authorization": "Bearer bca-tok"}, json=ev_payload)
                assert e1.status_code == 200 and e2.status_code == 200
                assert events == ["event:bca"]

                # 4. /v1/reviews/{key}/resolve idempotent replay vs 409 conflict
                events.clear()
                link_payload = {"action": "link", "transaction_id": parent_id}
                rv1 = client.post("/v1/reviews/ev-1/resolve", headers=HEADERS, json=link_payload)
                rv2 = client.post("/v1/reviews/ev-1/resolve", headers=HEADERS, json=link_payload)
                assert rv1.status_code == 200 and rv2.status_code == 200
                assert events == ["review:resolved"]
                assert client.post("/v1/reviews/ev-1/resolve", headers=HEADERS, json={"action": "ignore"}).status_code == 409
                assert client.post("/v1/reviews/ev-1/resolve", headers=HEADERS, json={"action": "link", "transaction_id": rf1.json()["id"]}).status_code == 409

                # 5. /v1/imports/{job_id}/commit idempotent replay vs 409 conflict
                events.clear()
                up = client.post(
                    "/v1/imports/upload",
                    headers=HEADERS,
                    data={"kind": "transactions"},
                    files={"file": ("imp.xlsx", _xlsx_bytes(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
                )
                job_id = up.json()["id"]
                prev = client.post(
                    f"/v1/imports/{job_id}/preview",
                    headers=HEADERS,
                    json={"sheets": [{"name": "transactions", "entity": "transactions"}]},
                )
                rev = prev.json()["revision"]
                cm1 = client.post(f"/v1/imports/{job_id}/commit", headers=HEADERS, json={"revision": rev})
                cm2 = client.post(f"/v1/imports/{job_id}/commit", headers=HEADERS, json={"revision": rev})
                assert cm1.status_code == 200 and cm2.status_code == 200
                assert events == ["import:done"]
                assert client.post(f"/v1/imports/{job_id}/commit", headers=HEADERS, json={"revision": rev, "exclude": [{"sheet": "transactions", "row": 2}]}).status_code == 409

                # 6. /v1/receipts/{job_id}/confirm idempotent replay vs 409 conflict
                events.clear()
                with Session(engine) as db:
                    r_job = store_file(db, OWNER, "receipt", "r.png", _tiny_png())
                    db.commit()
                    r_job_id = r_job.id
                fake_ai = {"merchant": "Warung", "direction": "expense", "amount": 15_000, "fee": 0, "total_amount": 15_000, "date": "2026-01-12"}
                with patch.object(ocr, "_scan_with_gemini", return_value=fake_ai):
                    assert client.post(f"/v1/receipts/{r_job_id}/process", headers=HEADERS).status_code == 200
                c_payload = {"transaction_id": parent_id}
                rc1 = client.post(f"/v1/receipts/{r_job_id}/confirm", headers=HEADERS, json=c_payload)
                rc2 = client.post(f"/v1/receipts/{r_job_id}/confirm", headers=HEADERS, json=c_payload)
                assert rc1.status_code == 200 and rc2.status_code == 200
                assert events == ["receipt:confirm"]
                assert client.post(f"/v1/receipts/{r_job_id}/confirm", headers=HEADERS, json={"transaction_id": rf1.json()["id"]}).status_code == 409
    finally:
        app.dependency_overrides.clear()
        engine.dispose()


def test_bootstrap_invalid_month_aligned_balances_and_exact_budget_threshold(monkeypatch):
    engine = _make_engine()
    monkeypatch.setenv("OWNER_ID", OWNER)
    monkeypatch.setenv("SAMSAKU_ENV", "development")
    monkeypatch.setenv("SAMSAKU_DEV_TOKEN", "m1-secret")

    today_wib = datetime.now(timezone(timedelta(hours=7))).date()
    active_month = f"{today_wib.year:04d}-{today_wib.month:02d}"
    future_day = date(today_wib.year, today_wib.month, min(28, today_wib.day))
    if future_day <= today_wib:
        # Pick end of next month if today is >= 28 so future_day is definitely > today_wib
        next_m = today_wib.month % 12 + 1
        next_y = today_wib.year + (1 if next_m == 1 else 0)
        future_day = date(next_y, next_m, 28)
        active_month = f"{next_y:04d}-{next_m:02d}"

    with Session(engine) as db:
        db.add(Account(id="acc1", owner_id=OWNER, code="BCA", name="BCA", kind="bank", opening_date=date(2025, 1, 1), opening_balance=1_000_000))
        db.add(Category(id="cat1", owner_id=OWNER, code="C1", name="C1", kind="expense"))
        db.add(Category(id="cat2", owner_id=OWNER, code="C2", name="C2", kind="expense"))
        post_transaction(db, OWNER, TransactionIn(date=today_wib, kind="expense", account_id="acc1", category_id="cat1", amount=100_000))
        post_transaction(db, OWNER, TransactionIn(date=future_day, kind="expense", account_id="acc1", category_id="cat1", amount=250_000))
        db.add(Budget(owner_id=OWNER, category_id="cat2", amount=101))
        db.commit()

        # Exact integer 80% threshold checks: 80/101 < 80% (safe), 81/101 >= 80% (warning)
        post_transaction(db, OWNER, TransactionIn(date=date(2026, 2, 5), kind="expense", account_id="acc1", category_id="cat2", amount=80))
        b_safe = list_budgets(db, OWNER, date(2026, 2, 1), date(2026, 2, 28))[0]
        assert b_safe["status"] == "safe"

        post_transaction(db, OWNER, TransactionIn(date=date(2026, 2, 5), kind="expense", account_id="acc1", category_id="cat2", amount=1))
        b_warn = list_budgets(db, OWNER, date(2026, 2, 1), date(2026, 2, 28))[0]
        assert b_warn["status"] == "warning"

        post_transaction(db, OWNER, TransactionIn(date=date(2026, 2, 5), kind="expense", account_id="acc1", category_id="cat2", amount=21))
        b_over = list_budgets(db, OWNER, date(2026, 2, 1), date(2026, 2, 28))[0]
        assert b_over["status"] == "over"

    def sessions():
        with Session(engine, expire_on_commit=False) as db:
            yield db

    app.dependency_overrides[get_db] = sessions
    try:
        with TestClient(app) as client:
            for bad_month in ("2026-00", "2026-13", "2026-99"):
                assert client.get("/v1/bootstrap", params={"month": bad_month}, headers=HEADERS).status_code == 422

            boot = client.get("/v1/bootstrap", params={"month": active_month}, headers=HEADERS)
            assert boot.status_code == 200
            payload = boot.json()
            assert payload["accounts"][0]["balance"] == 900_000
            assert payload["summary"]["accounts"][0]["balance"] == 900_000
    finally:
        app.dependency_overrides.clear()
        engine.dispose()
