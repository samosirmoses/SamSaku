"""Milestone 3 tests: pacing insights, alerts, goals, VPS edge security, PDF/backup hardening, WS caps & modularity."""
from datetime import date, timedelta
import importlib.util
import os
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

from fastapi import HTTPException
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core.config import cors_origins
from app.core.db import Base, get_db
from app.core.rate_limit import reset_rate_limiters
from app.main import app
from app.models import Account, Allocation, Category, Goal, Reserve, Scheme, Transaction
from app.schemas import TransactionIn
from app.services.calculations import cycle
from app.services.reports import MAX_PDF_DETAIL_ROWS, MAX_PDF_SPAN_DAYS, _PDF_SEMAPHORE, report_pdf, safe_cell
from app.services.summary import compute_cycle_pacing
from app.services.transactions import post_transaction

REPO_ROOT = Path(__file__).resolve().parents[2]


def _make_client_session():
    engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)

    def sessions():
        with Session(engine, expire_on_commit=False) as db:
            yield db

    return engine, sessions


def test_cycle_pacing_short_months_zero_budget_and_zero_income():
    # cycle_day=31 in non-leap February 2026: cycle starts 2026-01-31, next boundary 2026-02-28 (end=2026-02-27 -> 28 days)
    feb_start, next_boundary = cycle(31, date(2026, 2, 14))
    feb_end = next_boundary - timedelta(days=1)
    assert (feb_start, feb_end) == (date(2026, 1, 31), date(2026, 2, 27))

    # Leap February 2024: 2024-01-31 .. 2024-02-28 (29 days)
    leap_start, leap_next = cycle(31, date(2024, 2, 14))
    assert (leap_start, leap_next - timedelta(days=1)) == (date(2024, 1, 31), date(2024, 2, 28))

    # Mid-cycle with budget
    mid = compute_cycle_pacing(
        feb_start,
        feb_end,
        budgets=[{"amount": 2_800_000, "spent": 1_400_000, "status": "safe"}],
        income=5_000_000,
        expense=1_400_000,
        as_of=date(2026, 2, 13),  # day 14 of 28 -> 15 remaining incl. today
    )
    assert mid["days_total"] == 28
    assert mid["days_elapsed"] == 14
    assert mid["days_remaining"] == 15
    assert mid["elapsed_percent"] == 50
    assert mid["budget_spent_percent"] == 50
    assert mid["safe_daily_allowance"] == 1_400_000 // 15
    assert mid["allowance_basis"] == "budget"
    assert mid["pacing_status"] == "on_track"

    # Zero-budget with positive income falls back to net income / remaining days
    no_budget_inc = compute_cycle_pacing(
        feb_start,
        feb_end,
        budgets=[],
        income=3_000_000,
        expense=200_000,
        as_of=date(2026, 1, 31),
    )
    assert no_budget_inc["allowance_basis"] == "income"
    assert no_budget_inc["safe_daily_allowance"] == 2_800_000 // 28
    assert no_budget_inc["pacing_status"] == "no_budget"

    # Zero-budget AND zero-income returns 0 safely without ZeroDivisionError
    zero_all = compute_cycle_pacing(
        feb_start,
        feb_end,
        budgets=[],
        income=0,
        expense=0,
        as_of=date(2026, 2, 27),
    )
    assert zero_all["days_remaining"] == 1
    assert zero_all["safe_daily_allowance"] == 0
    assert zero_all["allowance_basis"] == "none"

    # Post-cycle returns 0 remaining days and 0 safe daily allowance
    closed = compute_cycle_pacing(
        feb_start,
        feb_end,
        budgets=[{"amount": 1_000_000, "spent": 800_000, "status": "warning"}],
        income=1_000_000,
        expense=800_000,
        as_of=date(2026, 3, 5),
    )
    assert closed["days_elapsed"] == 28
    assert closed["days_remaining"] == 0
    assert closed["safe_daily_allowance"] == 0
    assert closed["pacing_status"] == "ahead"


def test_budget_alerts_category_deltas_and_goals_crud(monkeypatch):
    engine, sessions = _make_client_session()
    app.dependency_overrides[get_db] = sessions
    owner_id = str(uuid4())
    monkeypatch.setenv("OWNER_ID", owner_id)
    monkeypatch.setenv("SAMSAKU_ENV", "development")
    monkeypatch.setenv("SAMSAKU_DEV_TOKEN", "m3-token")
    headers = {"X-Dev-Token": "m3-token"}
    reset_rate_limiters()

    try:
        with Session(engine) as db:
            acc = Account(id="a1", owner_id=owner_id, code="BCA", name="BCA", kind="bank", opening_balance=10_000_000, opening_date=date(2026, 1, 1))
            c_food = Category(id="c-food", owner_id=owner_id, code="FOOD", name="Makan", kind="expense")
            c_tr = Category(id="c-tr", owner_id=owner_id, code="TR", name="Transport", kind="expense")
            c_sal = Category(id="c-sal", owner_id=owner_id, code="SAL", name="Gaji", kind="income")
            db.add_all([acc, c_food, c_tr, c_sal])
            db.flush()

            # Previous cycle (2026-01): Makan 300k, Transport 100k
            post_transaction(db, owner_id, TransactionIn(date=date(2026, 1, 10), kind="expense", account_id="a1", category_id="c-food", amount=300_000, description="Jan Makan"))
            post_transaction(db, owner_id, TransactionIn(date=date(2026, 1, 12), kind="expense", account_id="a1", category_id="c-tr", amount=100_000, description="Jan Tr"))
            # Current cycle (2026-02): Makan 800k (80% warning of 1M), Transport 550k (>100% over of 500k)
            post_transaction(db, owner_id, TransactionIn(date=date(2026, 2, 5), kind="expense", account_id="a1", category_id="c-food", amount=800_000, description="Feb Makan"))
            post_transaction(db, owner_id, TransactionIn(date=date(2026, 2, 6), kind="expense", account_id="a1", category_id="c-tr", amount=550_000, description="Feb Tr"))
            db.commit()

        with TestClient(app) as client:
            assert client.post("/v1/budgets", headers=headers, json={"category_id": "c-food", "amount": 1_000_000}).status_code in (200, 201)
            assert client.post("/v1/budgets", headers=headers, json={"category_id": "c-tr", "amount": 500_000}).status_code in (200, 201)

            g_res = client.post("/v1/goals", headers=headers, json={"name": "Dana Darurat", "target": 5_000_000})
            assert g_res.status_code == 201
            goal_id = g_res.json()["id"]

            # Attach a Reserve referencing goal_id so DELETE /v1/goals/{id} proves safe unlinking
            with Session(engine) as db:
                inc_tx = Transaction(id="inc-1", owner_id=owner_id, date=date(2026, 2, 1), kind="income", account_id="a1", amount=5_000_000, description="Gaji", source="manual")
                sch = Scheme(id="sch-1", owner_id=owner_id, code="S1", name="Alokasi", cycle_day=1, rules=[])
                db.add_all([inc_tx, sch])
                db.flush()
                alloc = Allocation(id="al-1", owner_id=owner_id, scheme_id="sch-1", date=date(2026, 2, 1), cycle_start=date(2026, 2, 1), request_id="r-1", snapshot={})
                db.add(alloc)
                db.flush()
                db.add(Reserve(id="res-1", owner_id=owner_id, application_id="al-1", scheme_id="sch-1", income_id="inc-1", account_id="a1", pot_name="Darurat", goal_id=goal_id, amount=750_000, remaining=750_000, category_ids=[]))
                db.commit()

            boot = client.get("/v1/bootstrap", params={"month": "2026-02"}, headers=headers)
            assert boot.status_code == 200
            body = boot.json()
            assert [g["name"] for g in body["goals"]] == ["Dana Darurat"]
            assert body["goals"][0]["reserved"] == 750_000

            alerts = {a["category_name"]: a["status"] for a in body["summary"]["budget_alerts"]}
            assert alerts == {"Makan": "warning", "Transport": "over"}

            deltas = {d["name"]: d for d in body["summary"]["category_deltas"]}
            assert deltas["Makan"]["delta"] == 500_000
            assert deltas["Transport"]["delta"] == 450_000

            del_res = client.delete(f"/v1/goals/{goal_id}", headers=headers)
            assert del_res.status_code == 204
            with Session(engine) as db:
                assert db.get(Goal, goal_id) is None
                res_row = db.scalar(select(Reserve).where(Reserve.id == "res-1"))
                assert res_row is not None and res_row.goal_id is None
    finally:
        app.dependency_overrides.clear()
        engine.dispose()


def test_caddyfile_cors_rate_limit_and_pdf_bounds(monkeypatch):
    caddy = (REPO_ROOT / "ops" / "Caddyfile").read_text(encoding="utf-8")
    for expected in (
        "Content-Security-Policy",
        "X-Content-Type-Options \"nosniff\"",
        "X-Frame-Options \"DENY\"",
        "Referrer-Policy",
        "Permissions-Policy",
        "max_size 1MB",
        "max_size 8MB",
    ):
        assert expected in caddy, f"Missing security directive in Caddyfile: {expected}"

    # Production CORS validation
    monkeypatch.setenv("SAMSAKU_ENV", "production")
    monkeypatch.delenv("CORS_ORIGINS", raising=False)
    with pytest.raises(RuntimeError):
        cors_origins()
    monkeypatch.setenv("CORS_ORIGINS", "*")
    with pytest.raises(RuntimeError):
        cors_origins()
    monkeypatch.setenv("CORS_ORIGINS", "https://keuangan.example.com, https://admin.example.com")
    assert cors_origins() == ["https://keuangan.example.com", "https://admin.example.com"]

    # Bounded PDF checks
    with pytest.raises(HTTPException) as span_err:
        report_pdf({"start": date(2025, 1, 1), "end": date(2026, 6, 1), "transactions": []}, details=False)
    assert span_err.value.status_code == 422

    with pytest.raises(HTTPException) as rows_err:
        report_pdf(
            {"start": date(2026, 1, 1), "end": date(2026, 1, 31), "transactions": [{}] * (MAX_PDF_DETAIL_ROWS + 1)},
            details=True,
        )
    assert rows_err.value.status_code == 422

    assert MAX_PDF_SPAN_DAYS == 366
    assert _PDF_SEMAPHORE.acquire(blocking=False)
    try:
        with pytest.raises(HTTPException) as busy_err:
            report_pdf({"start": date(2026, 1, 1), "end": date(2026, 1, 2), "transactions": []}, details=False)
        assert busy_err.value.status_code == 429
    finally:
        _PDF_SEMAPHORE.release()

    # Backend safe_cell parity including leading tabs & CR
    assert safe_cell("\t=1+1") == "'\t=1+1"
    assert safe_cell("\tplain") == "'\tplain"
    assert safe_cell("\r=cmd") == "'\r=cmd"
    assert safe_cell("  =SUM(A1)") == "'  =SUM(A1)"

    # Rate limit enforcement on webhook endpoint
    engine, sessions = _make_client_session()
    app.dependency_overrides[get_db] = sessions
    monkeypatch.setenv("SAMSAKU_ENV", "development")
    monkeypatch.setenv("SAMSAKU_RATE_LIMIT_WEBHOOK_PER_MIN", "3")
    monkeypatch.setenv("TELEGRAM_WEBHOOK_SECRET", "sec-rl")
    reset_rate_limiters()
    try:
        with TestClient(app) as client:
            for _ in range(3):
                r = client.post("/v1/webhooks/telegram", headers={"X-Telegram-Bot-Api-Secret-Token": "sec-rl"}, json={"update_id": 1})
                assert r.status_code == 200
            blocked = client.post("/v1/webhooks/telegram", headers={"X-Telegram-Bot-Api-Secret-Token": "sec-rl"}, json={"update_id": 2})
            assert blocked.status_code == 429
            assert int(blocked.headers["Retry-After"]) >= 1
    finally:
        reset_rate_limiters()
        app.dependency_overrides.clear()
        engine.dispose()


def test_backup_privilege_reapplication():
    spec = importlib.util.spec_from_file_location("samsaku_backup", REPO_ROOT / "ops" / "backup.py")
    assert spec and spec.loader
    backup_mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(backup_mod)

    assert "REVOKE ALL ON TABLE public.%I FROM PUBLIC" in backup_mod.REVOKE_PRIVILEGES_SQL

    # Unit check command shape
    recorded = []
    backup_mod.reapply_table_privilege_hardening("postgresql+psycopg://u:p@host:5432/db", runner=lambda cmd, **kw: recorded.append((cmd, kw)))
    assert recorded[0][0][:2] == ["psql", "postgresql://u:p@host:5432/db"]
    assert recorded[0][1]["check"] is True

    # Live PostgreSQL verification when DATABASE_URL points to PostgreSQL
    db_url = os.getenv("DATABASE_URL", "")
    if db_url.startswith("postgresql"):
        import shutil
        if shutil.which("psql"):
            engine = create_engine(db_url)
            try:
                with engine.begin() as conn:
                    conn.execute(text("GRANT SELECT ON TABLE public.accounts TO PUBLIC"))
                    assert conn.execute(text("SELECT has_table_privilege('public', 'accounts', 'SELECT')")).scalar() is True
                backup_mod.reapply_table_privilege_hardening(db_url)
                with engine.begin() as conn:
                    assert conn.execute(text("SELECT has_table_privilege('public', 'accounts', 'SELECT')")).scalar() is False
            finally:
                engine.dispose()


def test_websocket_caps_origin_check_and_reconnect_sync(monkeypatch):
    engine, sessions = _make_client_session()
    app.dependency_overrides[get_db] = sessions
    owner_id = str(uuid4())
    monkeypatch.setenv("OWNER_ID", owner_id)
    monkeypatch.setenv("SAMSAKU_ENV", "development")
    monkeypatch.setenv("SAMSAKU_DEV_TOKEN", "ws-cap-secret")
    monkeypatch.setenv("SAMSAKU_WS_MAX_PER_OWNER", "2")
    monkeypatch.delenv("CORS_ORIGINS", raising=False)
    headers = {"X-Dev-Token": "ws-cap-secret"}
    reset_rate_limiters()

    try:
        with TestClient(app) as client:
            # 1. Per-owner cap rejects 3rd concurrent WebSocket with 4429
            with client.websocket_connect("/v1/ws") as ws1:
                ws1.send_json({"type": "auth", "dev_token": "ws-cap-secret"})
                assert ws1.receive_json() == {"type": "connected"}
                with client.websocket_connect("/v1/ws") as ws2:
                    ws2.send_json({"type": "auth", "dev_token": "ws-cap-secret"})
                    assert ws2.receive_json() == {"type": "connected"}
                    with client.websocket_connect("/v1/ws") as ws3:
                        ws3.send_json({"type": "auth", "dev_token": "ws-cap-secret"})
                        with pytest.raises(Exception) as exc:
                            ws3.receive_json()
                        assert getattr(exc.value, "code", None) == 4429

            # 2. Disconnected -> offline mutation -> reconnect + /bootstrap reconciles new balance
            with client.websocket_connect("/v1/ws") as ws:
                ws.send_json({"type": "auth", "dev_token": "ws-cap-secret"})
                assert ws.receive_json() == {"type": "connected"}
                acc = client.post(
                    "/v1/accounts",
                    headers=headers,
                    json={"name": "Offline Dompet", "kind": "bank", "opening_balance": 1_000_000, "opening_date": "2026-01-01"},
                ).json()
                assert ws.receive_json()["event"] == "account:created"

            # Mutation while client WebSocket is disconnected (missed push)
            tx_res = client.post(
                "/v1/transactions",
                headers=headers,
                json={"date": date.today().isoformat(), "kind": "expense", "account_id": acc["id"], "amount": 250_000, "description": "Offline tx"},
            )
            assert tx_res.status_code == 201

            # Reconnect WebSocket + trigger silent /bootstrap reconciliation
            with client.websocket_connect("/v1/ws") as ws_reconnected:
                ws_reconnected.send_json({"type": "auth", "dev_token": "ws-cap-secret"})
                assert ws_reconnected.receive_json() == {"type": "connected"}
                reconciled = client.get("/v1/bootstrap", headers=headers).json()
                dompet = next(a for a in reconciled["accounts"] if a["id"] == acc["id"])
                assert dompet["balance"] == 750_000
                assert any(t["description"] == "Offline tx" for t in reconciled["transactions"])

            # 3. Origin mismatch rejected when explicit CORS_ORIGINS configured
            monkeypatch.setenv("CORS_ORIGINS", "https://trusted.samsaku.id")
            with client.websocket_connect("/v1/ws", headers={"Origin": "https://evil.example"}) as ws_bad:
                with pytest.raises(Exception) as origin_exc:
                    ws_bad.receive_json()
                assert getattr(origin_exc.value, "code", None) == 4403
    finally:
        reset_rate_limiters()
        app.dependency_overrides.clear()
        engine.dispose()


def test_frontend_modularity_and_service_worker_invalidation():
    for rel in (
        "web/app/page.tsx",
        "web/components/layout/PageContent.tsx",
        "web/components/layout/AppDialogs.tsx",
        "web/features/transactions/EntryForm.tsx",
        "web/features/transactions/EntryHeaderControls.tsx",
        "web/features/transactions/EntryAmountBox.tsx",
        "web/features/transactions/EntryStandardFields.tsx",
        "web/features/transactions/EntryTransferFields.tsx",
        "web/features/transactions/EntryAdvancedSection.tsx",
        "web/features/transactions/EntryFormFooter.tsx",
        "web/features/transactions/entryPayload.ts",
        "web/features/transactions/useReceiptAutoFill.ts",
        "web/features/budgets/BudgetsView.tsx",
        "web/features/budgets/GoalsPanel.tsx",
        "web/features/statistics/StatisticsView.tsx",
        "web/features/dashboard/DashboardView.tsx",
    ):
        lines = (REPO_ROOT / rel).read_text(encoding="utf-8").splitlines()
        assert len(lines) < 400, f"{rel} melebihi batas modular 400 baris ({len(lines)} baris)"

    sw = (REPO_ROOT / "web" / "public" / "sw.js").read_text(encoding="utf-8")
    assert "skipWaiting()" in sw
    assert "clients.claim()" in sw
    assert "caches.delete" in sw
    assert 'url.pathname.startsWith("/v1/")' in sw
    assert "isHtmlNav" in sw and "fetch(req)" in sw
