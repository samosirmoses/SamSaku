"""Milestone 0 regression tests for ledger integrity, math precision, DB constraints, security, and concurrency."""
from datetime import date
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import time
from uuid import uuid4

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import create_engine, event, func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core.auth import owner
from app.core.db import Base, get_db
from app.main import app
from app.models import (
    Account,
    Budget,
    Category,
    Entry,
    Evidence,
    FileJob,
    Reserve,
    ReserveMovement,
    Scheme,
    Transaction,
)
from app.routers import telegram as tg_router
from app.schemas import AccountEdit, ApplyIn, CategoryEdit, TransactionIn
from app.services import ocr
from app.services.accounts import balance, delete_account, edit_account
from app.services.calculations import rupiah
from app.services.categories import delete_category, edit_category_item
from app.services.intake import draft
from app.services.jobs import store_file
from app.services.planning import plan_allocation
from app.services.summary import summary
from app.services.transactions import delete_transaction, post_transaction, update_transaction
from app.services.xlsx import money as xlsx_money

OWNER = "00000000-0000-4000-8000-000000000099"
DAY = date(2026, 1, 25)


def _make_sqlite_engine():
    engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})

    @event.listens_for(engine, "connect")
    def _fk(conn, _rec):
        conn.execute("PRAGMA foreign_keys=ON")

    Base.metadata.create_all(engine)
    return engine


@pytest.fixture
def db():
    engine = _make_sqlite_engine()
    with Session(engine, expire_on_commit=False) as session:
        session.add(Account(id="BCA", owner_id=OWNER, name="BCA", code="BCA", opening_date=DAY, opening_balance=1_000_000))
        session.add(Account(id="GOPAY", owner_id=OWNER, name="GoPay", code="GOPAY", opening_date=DAY, opening_balance=0))
        session.add(Account(id="CC", owner_id=OWNER, name="Kartu Kredit", code="CC", opening_date=DAY, opening_balance=-250_000))
        session.add(Account(id="UNANCHORED", owner_id=OWNER, name="Tunai Lama", code="OLD", opening_date=None, opening_balance=None))
        session.add(Category(id="FOOD", owner_id=OWNER, name="Makanan", code="FOOD", kind="expense"))
        session.add(Category(id="TRANS", owner_id=OWNER, name="Transportasi", code="TRANS", kind="expense"))
        session.add(Category(id="SAL", owner_id=OWNER, name="Gaji", code="SAL", kind="income"))
        session.commit()
        yield session
    engine.dispose()


def _tiny_png() -> bytes:
    buf = BytesIO()
    Image.new("RGB", (64, 64), color=(255, 255, 255)).save(buf, format="PNG")
    return buf.getvalue()


def test_transfer_rollback_negative_and_unanchored_balance_reconciliation(db):
    assert balance(db, db.get(Account, "GOPAY")) == 0
    assert balance(db, db.get(Account, "CC")) == -250_000
    assert balance(db, db.get(Account, "UNANCHORED")) is None

    # Pre-opening transaction stays out of balance
    post_transaction(db, OWNER, TransactionIn(date=date(2026, 1, 20), kind="expense", account_id="CC", amount=50_000))
    assert balance(db, db.get(Account, "CC")) == -250_000

    tf = post_transaction(
        db,
        OWNER,
        TransactionIn(date=DAY, kind="transfer", account_id="BCA", to_account_id="GOPAY", amount=200_000, fee=2_500),
    )
    assert balance(db, db.get(Account, "BCA")) == 797_500
    assert balance(db, db.get(Account, "GOPAY")) == 200_000
    assert summary(db, OWNER, DAY, DAY)["expense"] == 2_500

    # Edit transfer to different target/amount/fee and check reconciliation
    update_transaction(
        db,
        OWNER,
        tf.id,
        TransactionIn(date=DAY, kind="transfer", account_id="BCA", to_account_id="CC", amount=150_000, fee=1_000),
    )
    assert balance(db, db.get(Account, "BCA")) == 849_000
    assert balance(db, db.get(Account, "GOPAY")) == 0
    assert balance(db, db.get(Account, "CC")) == -100_000
    assert summary(db, OWNER, DAY, DAY)["expense"] == 1_000

    # Delete transfer -> complete rollback
    delete_transaction(db, OWNER, tf.id)
    assert balance(db, db.get(Account, "BCA")) == 1_000_000
    assert balance(db, db.get(Account, "GOPAY")) == 0
    assert balance(db, db.get(Account, "CC")) == -250_000
    assert summary(db, OWNER, DAY, DAY)["expense"] == 0

    # Double-entry invariant: opening_balance + sum(entries >= opening_date) == balance
    for acc_id in ("BCA", "GOPAY", "CC"):
        acc = db.get(Account, acc_id)
        entry_sum = int(
            db.scalar(
                select(func.coalesce(func.sum(Entry.delta), 0))
                .join(Transaction, Transaction.id == Entry.transaction_id)
                .where(Entry.account_id == acc.id, Transaction.date >= acc.opening_date)
            )
            or 0
        )
        assert (acc.opening_balance or 0) + entry_sum == balance(db, acc)

    # Editing unrelated field on unanchored account keeps opening_balance/date None
    edit_account(db, OWNER, "UNANCHORED", AccountEdit(name="Tunai Renamed"))
    unanchored = db.get(Account, "UNANCHORED")
    assert unanchored.opening_balance is None and unanchored.opening_date is None


def test_reserve_integrity_across_edits_deletes_and_cascade(db, monkeypatch):
    monkeypatch.setattr("app.services.planning.today", lambda: DAY)
    inc = post_transaction(db, OWNER, TransactionIn(date=DAY, kind="income", account_id="BCA", amount=2_000_000))
    scheme = Scheme(
        owner_id=OWNER,
        name="Pos",
        code="POS",
        cycle_day=25,
        rules=[{"name": "Makan", "mode": "fixed", "value": 500_000, "category_ids": ["FOOD"]}],
    )
    db.add(scheme)
    db.flush()
    req = ApplyIn(date=DAY, request_id="alloc-1", income_ids=[inc.id])
    quote = plan_allocation(db, OWNER, scheme.id, req)
    plan_allocation(db, OWNER, scheme.id, req.model_copy(update={"revision": quote["revision"]}), True)
    reserve = db.scalar(select(Reserve).where(Reserve.owner_id == OWNER))
    assert reserve.amount == 500_000 and reserve.remaining == 500_000

    # Repeated expense edits must NOT double-deduct Reserve.remaining
    exp = post_transaction(db, OWNER, TransactionIn(date=DAY, kind="expense", account_id="BCA", category_id="FOOD", amount=100_000))
    db.refresh(reserve)
    assert reserve.remaining == 400_000

    update_transaction(db, OWNER, exp.id, TransactionIn(date=DAY, kind="expense", account_id="BCA", category_id="FOOD", amount=150_000))
    db.refresh(reserve)
    assert reserve.remaining == 350_000

    update_transaction(db, OWNER, exp.id, TransactionIn(date=DAY, kind="expense", account_id="BCA", category_id="FOOD", amount=120_000))
    db.refresh(reserve)
    assert reserve.remaining == 380_000

    # Repeated refund edits must NOT double-restore Reserve.remaining or exceed amount
    ref = post_transaction(
        db,
        OWNER,
        TransactionIn(date=DAY, kind="refund", account_id="BCA", category_id="FOOD", amount=20_000, original_id=exp.id),
    )
    db.refresh(reserve)
    assert reserve.remaining == 400_000

    update_transaction(
        db,
        OWNER,
        ref.id,
        TransactionIn(date=DAY, kind="refund", account_id="BCA", category_id="FOOD", amount=50_000, original_id=exp.id),
    )
    db.refresh(reserve)
    assert reserve.remaining == 430_000

    # Delete refund first -> restores pre-refund remaining, then delete expense -> full reserve restored
    delete_transaction(db, OWNER, ref.id)
    db.refresh(reserve)
    assert reserve.remaining == 380_000

    delete_transaction(db, OWNER, exp.id)
    db.refresh(reserve)
    assert reserve.remaining == 500_000
    assert db.scalar(select(func.count()).select_from(ReserveMovement).where(ReserveMovement.owner_id == OWNER)) == 0

    # Recreate expense + refund and verify cascade delete_account handles FK order cleanly
    exp2 = post_transaction(db, OWNER, TransactionIn(date=DAY, kind="expense", account_id="BCA", category_id="FOOD", amount=80_000))
    post_transaction(db, OWNER, TransactionIn(date=DAY, kind="refund", account_id="BCA", category_id="FOOD", amount=30_000, original_id=exp2.id))
    db.commit()
    delete_account(db, OWNER, "BCA", cascade=True)
    db.commit()
    assert db.get(Account, "BCA") is None
    assert db.scalar(select(func.count()).select_from(Reserve).where(Reserve.owner_id == OWNER)) == 0
    assert db.scalar(select(func.count()).select_from(ReserveMovement).where(ReserveMovement.owner_id == OWNER)) == 0


def test_delete_category_updates_reserves_and_schemes(db, monkeypatch):
    monkeypatch.setattr("app.services.planning.today", lambda: DAY)
    inc = post_transaction(db, OWNER, TransactionIn(date=DAY, kind="income", account_id="BCA", amount=1_000_000))
    scheme = Scheme(
        owner_id=OWNER,
        name="Harian",
        code="DAILY",
        cycle_day=25,
        rules=[{"name": "Makan", "mode": "fixed", "value": 400_000, "category_ids": ["FOOD"]}],
    )
    db.add(scheme)
    db.flush()
    req = ApplyIn(date=DAY, request_id="alloc-cat", income_ids=[inc.id])
    quote = plan_allocation(db, OWNER, scheme.id, req)
    plan_allocation(db, OWNER, scheme.id, req.model_copy(update={"revision": quote["revision"]}), True)
    post_transaction(db, OWNER, TransactionIn(date=DAY, kind="expense", account_id="BCA", category_id="FOOD", amount=100_000))

    # Delete without transfer_to -> restores reserve.remaining and prunes FOOD from JSON lists
    delete_category(db, OWNER, "FOOD")
    reserve = db.scalar(select(Reserve).where(Reserve.owner_id == OWNER))
    db.refresh(scheme)
    assert reserve.remaining == 400_000
    assert reserve.category_ids == []
    assert scheme.rules[0]["category_ids"] == []

    # Now test with transfer_to -> remaps movement & JSON category_ids without changing remaining
    cat2 = Category(id="SNACK", owner_id=OWNER, name="Jajan", code="SNACK", kind="expense")
    db.add(cat2)
    scheme.rules = [{"name": "Makan", "mode": "fixed", "value": 400_000, "category_ids": ["SNACK"]}]
    reserve.category_ids = ["SNACK"]
    db.flush()
    post_transaction(db, OWNER, TransactionIn(date=DAY, kind="expense", account_id="BCA", category_id="SNACK", amount=50_000))
    delete_category(db, OWNER, "SNACK", transfer_to="TRANS")
    db.refresh(reserve)
    db.refresh(scheme)
    assert reserve.remaining == 350_000
    assert reserve.category_ids == ["TRANS"]
    assert scheme.rules[0]["category_ids"] == ["TRANS"]
    mv = db.scalar(select(ReserveMovement).where(ReserveMovement.owner_id == OWNER))
    assert mv.category_id == "TRANS"


def test_parent_expense_allocated_income_and_category_kind_guards(db, monkeypatch):
    monkeypatch.setattr("app.services.planning.today", lambda: DAY)
    exp = post_transaction(db, OWNER, TransactionIn(date=DAY, kind="expense", account_id="BCA", category_id="FOOD", amount=100_000))
    ref = post_transaction(
        db,
        OWNER,
        TransactionIn(date=date(2026, 1, 26), kind="refund", account_id="BCA", category_id="FOOD", amount=60_000, original_id=exp.id),
    )

    # Blocked: shrink below refunded, switch category, switch kind, move date past refund, or delete parent
    for bad in (
        TransactionIn(date=DAY, kind="expense", account_id="BCA", category_id="FOOD", amount=50_000),
        TransactionIn(date=DAY, kind="expense", account_id="BCA", category_id="TRANS", amount=100_000),
        TransactionIn(date=DAY, kind="income", account_id="BCA", category_id="SAL", amount=100_000),
        TransactionIn(date=date(2026, 1, 27), kind="expense", account_id="BCA", category_id="FOOD", amount=100_000),
    ):
        with pytest.raises(HTTPException) as err:
            update_transaction(db, OWNER, exp.id, bad)
        assert err.value.status_code == 409

    with pytest.raises(HTTPException) as del_err:
        delete_transaction(db, OWNER, exp.id)
    assert del_err.value.status_code == 409

    # Safe edit (increasing amount) succeeds
    update_transaction(db, OWNER, exp.id, TransactionIn(date=DAY, kind="expense", account_id="BCA", category_id="FOOD", amount=120_000))
    delete_transaction(db, OWNER, ref.id)
    delete_transaction(db, OWNER, exp.id)

    # Allocated income guards
    inc = post_transaction(db, OWNER, TransactionIn(date=DAY, kind="income", account_id="BCA", category_id="SAL", amount=1_000_000))
    scheme = Scheme(
        owner_id=OWNER,
        name="Tabungan",
        code="SAV",
        cycle_day=25,
        rules=[{"name": "Simpan", "mode": "fixed", "value": 700_000, "category_ids": []}],
    )
    db.add(scheme)
    db.flush()
    req = ApplyIn(date=DAY, request_id="alloc-inc", income_ids=[inc.id])
    quote = plan_allocation(db, OWNER, scheme.id, req)
    plan_allocation(db, OWNER, scheme.id, req.model_copy(update={"revision": quote["revision"]}), True)

    with pytest.raises(HTTPException) as inc_err:
        update_transaction(db, OWNER, inc.id, TransactionIn(date=DAY, kind="income", account_id="BCA", category_id="SAL", amount=500_000))
    assert inc_err.value.status_code == 409
    with pytest.raises(HTTPException) as inc_del_err:
        delete_transaction(db, OWNER, inc.id)
    assert inc_del_err.value.status_code == 409

    # Category.kind flip blocked when referenced (e.g. by budget or transaction)
    db.add(Budget(owner_id=OWNER, category_id="FOOD", amount=300_000))
    db.flush()
    with pytest.raises(HTTPException) as cat_err:
        edit_category_item(db, OWNER, "FOOD", CategoryEdit(kind="income"))
    assert cat_err.value.status_code == 409

    # Unreferenced category can flip kind
    unused = Category(id="UNUSED", owner_id=OWNER, name="Lain", code="UNUSED", kind="expense")
    db.add(unused)
    db.flush()
    updated = edit_category_item(db, OWNER, "UNUSED", CategoryEdit(kind="income"))
    assert updated.kind == "income"


def test_xlsx_money_and_rupiah_and_linear_parser_rules(monkeypatch):
    assert xlsx_money("1,000") == 1000
    assert xlsx_money("50,000") == 50000
    assert xlsx_money("50,000.00") == 50000
    assert xlsx_money("50.000,00") == 50000
    assert xlsx_money("IDR 50,000.00") == 50000
    assert xlsx_money("-50,000", signed=True) == -50000

    for bad in ("1.250,50", "1,234.50", "1,0000", "1.000,000", "1234.50"):
        with pytest.raises(ValueError):
            xlsx_money(bad)
    with pytest.raises(ValueError):
        xlsx_money("-50,000", signed=False)

    assert rupiah("IDR 50000.00") == 50000
    assert rupiah("Rp. 50.000") == 50000
    assert rupiah("Rp 20.00") is None

    rules_path = Path(__file__).resolve().parents[1] / "parser-rules.local.json"
    monkeypatch.setenv("SAMSAKU_PARSER_RULES", str(rules_path))
    engine = _make_sqlite_engine()
    with Session(engine) as db:
        db.add(Account(id="BCA", owner_id=OWNER, name="BCA", code="BCA"))
        db.commit()

        # Field order 1 (merchant before total) with IDR 50000.00
        mail1 = (
            "Status : Berhasil\n"
            "Tanggal Transaksi : 24 Nov 2026 20:08:45\n"
            "Pembayaran Ke : Kopi Tuku\n"
            "Total Bayar : IDR 50000.00\n"
            "Nomor Referensi : REF001"
        )
        parsed1, auto1 = draft(db, OWNER, "bca", mail1, DAY)
        assert auto1 is True and parsed1["amount"] == 50000 and parsed1["source_ref"] == "REF001"

        # Field order 2 (amount before merchant) with IDR 32,000.00
        mail2 = (
            "Status : Berhasil\n"
            "Tanggal : 24/11/2026\n"
            "Nominal : IDR 32,000.00\n"
            "Merchant : Indomaret\n"
            "No. Referensi : REF002"
        )
        parsed2, auto2 = draft(db, OWNER, "bca", mail2, DAY)
        assert auto2 is True and parsed2["amount"] == 32000 and parsed2["source_ref"] == "REF002"

        # 32 KB partial-match ReDoS test must finish in < 50 ms
        evil = (
            "Status : Berhasil\n"
            "Tanggal Transaksi : 24 Nov 2026 20:08:45\n"
            "Pembayaran Ke : Merchant Panjang\n"
            "Total Bayar : IDR 32,000.00\n"
            + ("Detail : abcdefghij\n" * 1600)
        )[:32000]
        t0 = time.perf_counter()
        parsed_evil, auto_evil = draft(db, OWNER, "bca", evil, DAY)
        elapsed_ms = (time.perf_counter() - t0) * 1000
        assert auto_evil is False and parsed_evil == {}
        assert elapsed_ms < 50.0, f"Parser took {elapsed_ms:.1f} ms on 32 KB payload"
    engine.dispose()


def test_db_check_constraints_reject_invalid_writes():
    engine = _make_sqlite_engine()
    with engine.begin() as conn:
        conn.execute(text("INSERT INTO accounts (id, owner_id, code, name, kind, currency) VALUES ('a1', 'u1', 'A1', 'A1', 'bank', 'IDR')"))
        conn.execute(text("INSERT INTO accounts (id, owner_id, code, name, kind, currency) VALUES ('a2', 'u1', 'A2', 'A2', 'bank', 'IDR')"))
        conn.execute(text("INSERT INTO categories (id, owner_id, code, name, kind, archived) VALUES ('c1', 'u1', 'C1', 'C1', 'expense', 0)"))

    bad_sql = [
        "INSERT INTO categories (id, owner_id, code, name, kind, archived) VALUES ('cbad', 'u1', 'CB', 'Bad', 'transfer', 0)",
        "INSERT INTO categories (id, owner_id, code, name, kind, parent_id, archived) VALUES ('cself', 'u1', 'CS', 'Self', 'expense', 'cself', 0)",
        "INSERT INTO transactions (id, owner_id, date, kind, account_id, amount, fee, description, source, created_at) VALUES ('t1', 'u1', '2026-01-25', 'expense', 'a1', 0, 0, '', 'manual', '2026-01-25T00:00:00Z')",
        "INSERT INTO transactions (id, owner_id, date, kind, account_id, amount, fee, description, source, created_at) VALUES ('t2', 'u1', '2026-01-25', 'expense', 'a1', 1000, -1, '', 'manual', '2026-01-25T00:00:00Z')",
        "INSERT INTO transactions (id, owner_id, date, kind, account_id, amount, fee, description, source, created_at) VALUES ('t3', 'u1', '2026-01-25', 'invalid', 'a1', 1000, 0, '', 'manual', '2026-01-25T00:00:00Z')",
        "INSERT INTO transactions (id, owner_id, date, kind, account_id, to_account_id, amount, fee, description, source, created_at) VALUES ('t4', 'u1', '2026-01-25', 'transfer', 'a1', 'a1', 1000, 0, '', 'manual', '2026-01-25T00:00:00Z')",
        "INSERT INTO budgets (id, owner_id, category_id, amount) VALUES ('b1', 'u1', 'c1', 0)",
        "INSERT INTO goals (id, owner_id, name, target) VALUES ('g1', 'u1', 'Dana', 0)",
    ]
    for stmt in bad_sql:
        with pytest.raises(IntegrityError):
            with engine.begin() as conn:
                conn.execute(text(stmt))

    # Also verify Reserve bounds check
    with engine.begin() as conn:
        conn.execute(text("INSERT INTO transactions (id, owner_id, date, kind, account_id, amount, fee, description, source, created_at) VALUES ('t_ok', 'u1', '2026-01-25', 'income', 'a1', 5000, 0, '', 'manual', '2026-01-25T00:00:00Z')"))
        conn.execute(text("INSERT INTO schemes (id, owner_id, code, name, cycle_day, rules) VALUES ('s1', 'u1', 'S1', 'S1', 1, '[]')"))
        conn.execute(text("INSERT INTO scheme_applications (id, owner_id, scheme_id, request_id, date, cycle_start, snapshot) VALUES ('sa1', 'u1', 's1', 'r1', '2026-01-25', '2026-01-01', '{}')"))
    for stmt in (
        "INSERT INTO reserves (id, owner_id, application_id, scheme_id, income_id, account_id, pot_name, amount, remaining, category_ids) VALUES ('r1', 'u1', 'sa1', 's1', 't_ok', 'a1', 'P', 1000, -1, '[]')",
        "INSERT INTO reserves (id, owner_id, application_id, scheme_id, income_id, account_id, pot_name, amount, remaining, category_ids) VALUES ('r2', 'u1', 'sa1', 's1', 't_ok', 'a1', 'P', 1000, 1001, '[]')",
    ):
        with pytest.raises(IntegrityError):
            with engine.begin() as conn:
                conn.execute(text(stmt))
    engine.dispose()


def test_security_ws_no_query_token_prod_guard_and_gemini_header(monkeypatch):
    monkeypatch.setenv("SAMSAKU_ENV", " Production ")
    monkeypatch.setenv("SAMSAKU_DEV_TOKEN", "dev-tok")
    monkeypatch.setenv("OWNER_ID", str(uuid4()))
    with pytest.raises(HTTPException) as err:
        owner("", "dev-tok")
    assert err.value.status_code == 401

    monkeypatch.setenv("SAMSAKU_ENV", "test")
    monkeypatch.setenv("SAMSAKU_DEV_TOKEN", "ws-sec")
    with TestClient(app) as client:
        with client.websocket_connect("/v1/ws?dev_token=ws-sec") as ws:
            with pytest.raises(Exception):
                ws.receive_json()
        with client.websocket_connect("/v1/ws?token=ws-sec") as ws:
            with pytest.raises(Exception):
                ws.receive_json()

    # Gemini Vision must send API key in header, not query param
    monkeypatch.setenv("SAMSAKU_ENV", "development")
    monkeypatch.setenv("GEMINI_API_KEY", "secret-gemini-key")
    captured = {}

    class _FakeResp:
        status_code = 200
        text = ""

        def json(self):
            return {"candidates": [{"content": {"parts": [{"text": '{"merchant":"Warung","amount":15000}'}]}}]}

    class _SpyClient:
        def post(self, url, **kwargs):
            captured["url"] = url
            captured["kwargs"] = kwargs
            return _FakeResp()

    with patch.object(ocr, "get_http_client", return_value=_SpyClient()):
        parsed = ocr._scan_with_gemini(_tiny_png(), ["Makan"])
        assert parsed and parsed["amount"] == 15000
    assert captured["kwargs"].get("params") is None
    assert captured["kwargs"].get("headers", {}).get("x-goog-api-key") == "secret-gemini-key"
    assert "secret-gemini-key" not in captured["url"]


def test_concurrency_lock_release_and_telegram_poller_resilience(monkeypatch):
    engine = _make_sqlite_engine()
    monkeypatch.setenv("SAMSAKU_ENV", "development")
    monkeypatch.setenv("SAMSAKU_DEV_TOKEN", "conc-tok")
    monkeypatch.setenv("OWNER_ID", OWNER)
    monkeypatch.setenv("GEMINI_API_KEY", "fake-key")
    monkeypatch.setenv("TELEGRAM_WEBHOOK_SECRET", "tg-sec")
    monkeypatch.setenv("TELEGRAM_USER_ID", "77")

    with Session(engine, expire_on_commit=False) as db:
        db.add(Account(id="BCA", owner_id=OWNER, name="myBCA", code="BCA", kind="bank", opening_date=DAY, opening_balance=1_000_000))
        job = store_file(db, OWNER, "receipt", "struk.png", _tiny_png())
        db.commit()
        job_id = job.id

    tx_state_during_gemini = []

    def failing_gemini(*_a, **_kw):
        # At the moment external HTTP runs, the session passed to process_receipt must NOT hold an open tx
        tx_state_during_gemini.append(session_ref.in_transaction())
        return None

    with Session(engine, expire_on_commit=False) as session_ref:
        with patch.object(ocr, "_scan_with_gemini", side_effect=failing_gemini):
            with pytest.raises(HTTPException) as err:
                ocr.process_receipt(session_ref, OWNER, job_id)
            assert err.value.status_code == 503
        assert tx_state_during_gemini == [False]
        reloaded_job = session_ref.get(FileJob, job_id)
        assert reloaded_job.status == "uploaded"

    # Telegram photo: download_photo & _scan_with_gemini run outside DB tx; failure does not stick Evidence in "forwarded"
    def sessions():
        with Session(engine, expire_on_commit=False) as s:
            yield s

    app.dependency_overrides[get_db] = sessions
    photo_update = {
        "update_id": 888,
        "message": {
            "date": 1795651200,
            "from": {"id": 77},
            "chat": {"id": 77, "type": "private"},
            "photo": [{"file_id": "f1", "width": 800, "file_size": 1000}],
        },
    }
    try:
        with TestClient(app) as client:
            with patch.object(tg_router, "download_photo", return_value=_tiny_png()), patch.object(
                ocr, "_scan_with_gemini", return_value=None
            ):
                fail_res = client.post(
                    "/v1/webhooks/telegram",
                    headers={"X-Telegram-Bot-Api-Secret-Token": "tg-sec"},
                    json=photo_update,
                )
                assert fail_res.status_code == 503
        with Session(engine) as db:
            ev = db.scalar(select(Evidence).where(Evidence.owner_id == OWNER, Evidence.source == "telegram"))
            assert ev is not None and ev.status == "review"

        # Poller must NOT advance offset on failed update, and DOES advance on retry success
        class _PollHttp:
            def __init__(self, updates):
                self._updates = updates
                self.posts = []

            def get(self, *_a, **_kw):
                return SimpleNamespace(status_code=200, json=lambda: {"result": self._updates})

            def post(self, url, **kw):
                self.posts.append((url, kw))
                return SimpleNamespace(status_code=200)

        calls = {"n": 0}

        def flaky_receive(upd, **_kw):
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("transient error")
            return {"method": "sendMessage", "chat_id": 77, "text": "OK"}

        poll_http = _PollHttp([{"update_id": 10, "message": {"date": 1795651200, "from": {"id": 77}, "chat": {"id": 77, "type": "private"}, "text": "hi"}}])
        fail_counts: dict[int, int] = {}
        with patch.object(tg_router, "receive", side_effect=flaky_receive):
            off1 = tg_router._poll_once(poll_http, "https://api.telegram.org/botx", "tg-sec", 0, session_factory=lambda: Session(engine), fail_counts=fail_counts)
            assert off1 == 0 and fail_counts[10] == 1
            off2 = tg_router._poll_once(poll_http, "https://api.telegram.org/botx", "tg-sec", off1, session_factory=lambda: Session(engine), fail_counts=fail_counts)
            assert off2 == 11 and 10 not in fail_counts
    finally:
        app.dependency_overrides.clear()
        engine.dispose()
