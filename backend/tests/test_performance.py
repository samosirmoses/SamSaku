"""Query-count (anti N+1) and bootstrap performance regression tests."""
from datetime import date

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core.db import Base, get_db
from app.main import app
from app.models import Account, Budget, Category
from app.schemas import TransactionIn
from app.services.transactions import post_transaction


def test_accounts_transactions_and_bootstrap_avoid_n_plus_1(monkeypatch):
    engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)

    owner_id = "00000000-0000-4000-8000-000000000001"
    monkeypatch.setenv("OWNER_ID", owner_id)
    monkeypatch.setenv("SAMSAKU_ENV", "development")
    monkeypatch.setenv("SAMSAKU_DEV_TOKEN", "perf-token")

    with Session(engine) as db:
        for i in range(12):
            db.add(
                Account(
                    id=f"acc-{i}",
                    owner_id=owner_id,
                    code=f"A{i}",
                    name=f"Dompet {i}",
                    kind="bank",
                    opening_date=date(2026, 1, 1),
                    opening_balance=1_000_000,
                )
            )
        for i in range(8):
            db.add(Category(id=f"cat-{i}", owner_id=owner_id, code=f"C{i}", name=f"Kategori {i}", kind="expense"))
            db.add(Budget(owner_id=owner_id, category_id=f"cat-{i}", amount=500_000))
        db.commit()
        for i in range(40):
            post_transaction(
                db,
                owner_id,
                TransactionIn(
                    date=date(2026, 1, (i % 28) + 1),
                    kind="expense",
                    account_id=f"acc-{i % 12}",
                    category_id=f"cat-{i % 8}",
                    amount=15_000 + i * 100,
                    description=f"Transaksi {i}",
                ),
            )
        db.commit()

    query_count = 0

    @event.listens_for(engine, "before_cursor_execute")
    def _count_queries(*_args):
        nonlocal query_count
        query_count += 1

    def sessions():
        with Session(engine, expire_on_commit=False) as db:
            yield db

    app.dependency_overrides[get_db] = sessions
    headers = {"X-Dev-Token": "perf-token"}
    try:
        with TestClient(app) as client:
            # 12 accounts must NOT trigger 3 * 12 = 36+ queries
            query_count = 0
            res_acc = client.get("/v1/accounts", headers=headers)
            assert res_acc.status_code == 200
            assert len(res_acc.json()) == 12
            assert query_count <= 6, f"Expected O(1) queries for /v1/accounts, got {query_count}"

            # 40 transactions must NOT trigger 40+ N+1 queries
            query_count = 0
            res_tx = client.get("/v1/transactions", headers=headers)
            assert res_tx.status_code == 200
            assert len(res_tx.json()) == 40
            assert query_count <= 6, f"Expected O(1) queries for /v1/transactions, got {query_count}"

            # Single /v1/bootstrap call replaces 7 HTTP requests and stays bounded in SQL queries
            query_count = 0
            res_boot = client.get("/v1/bootstrap", params={"month": "2026-01"}, headers=headers)
            assert res_boot.status_code == 200
            boot = res_boot.json()
            assert len(boot["accounts"]) == 12
            assert len(boot["transactions"]) == 40
            assert len(boot["budgets"]) == 8
            assert query_count <= 15, f"Expected bounded queries for /v1/bootstrap, got {query_count}"
    finally:
        app.dependency_overrides.clear()
        engine.dispose()
