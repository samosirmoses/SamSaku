"""Tests for POST /v1/data/reset (flexible partial reset & full wipe)."""
from datetime import date
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core.db import Base, get_db
from app.main import app


@pytest.fixture
def client(monkeypatch):
    engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    monkeypatch.setenv("OWNER_ID", str(uuid4()))
    monkeypatch.setenv("SAMSAKU_ENV", "development")
    monkeypatch.setenv("SAMSAKU_DEV_TOKEN", "reset-test-token")

    def override_db():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_db] = override_db
    try:
        with TestClient(app, headers={"X-Dev-Token": "reset-test-token"}) as c:
            yield c
    finally:
        app.dependency_overrides.clear()
        engine.dispose()


def _seed(client):
    acc = client.post(
        "/v1/accounts",
        json={
            "name": "BCA Utama",
            "kind": "bank",
            "opening_date": "2026-01-01",
            "opening_balance": 1_000_000,
        },
    ).json()
    cat = client.post(
        "/v1/categories",
        json={"name": "Makan", "kind": "expense"},
    ).json()
    tx = client.post(
        "/v1/transactions",
        json={
            "date": date(2026, 2, 10).isoformat(),
            "kind": "expense",
            "account_id": acc["id"],
            "category_id": cat["id"],
            "amount": 50_000,
            "description": "Sarapan",
        },
    ).json()
    client.post(
        "/v1/budgets",
        json={"category_id": cat["id"], "amount": 500_000},
    )
    client.put(
        "/v1/settings",
        json={"monthly_start_day": 25, "weekly_start_day": 0, "default_account_id": acc["id"]},
    )
    return acc, cat, tx


def test_reset_validation_errors(client):
    r1 = client.post("/v1/data/reset", json={"mode": "partial", "confirm": "SALAH", "reset_transactions": True})
    assert r1.status_code == 400

    r2 = client.post("/v1/data/reset", json={"mode": "partial", "confirm": "RESET"})
    assert r2.status_code == 400

    r3 = client.post("/v1/data/reset", json={"mode": "wipe", "confirm": "RESET"})
    assert r3.status_code == 400


def test_partial_reset_transactions_and_options(client):
    acc, cat, _tx = _seed(client)

    # Reset transactions only
    res = client.post(
        "/v1/data/reset",
        json={
            "mode": "partial",
            "confirm": "RESET",
            "reset_transactions": True,
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["mode"] == "partial"
    assert body["deleted"]["transactions"] == 1
    assert body["deleted"]["budgets"] == 0
    assert body["zeroed_accounts"] == 0

    # Transactions gone, but account + opening_balance + category + budget + settings remain
    assert client.get("/v1/transactions?start=2026-01-01&end=2026-12-31").json() == []
    accounts = client.get("/v1/accounts").json()
    assert len(accounts) == 1
    assert accounts[0]["id"] == acc["id"]
    assert accounts[0]["opening_balance"] == 1_000_000
    assert accounts[0]["balance"] == 1_000_000
    assert len(client.get("/v1/categories").json()) == 1
    assert len(client.get("/v1/budgets").json()) == 1
    assert client.get("/v1/settings").json()["monthly_start_day"] == 25

    # Now zero opening balances and clear budgets
    res2 = client.post(
        "/v1/data/reset",
        json={
            "mode": "partial",
            "confirm": "reset",
            "zero_opening_balances": True,
            "clear_budgets": True,
            "clear_evidence": True,
        },
    )
    assert res2.status_code == 200
    b2 = res2.json()
    assert b2["zeroed_accounts"] == 1
    assert b2["deleted"]["budgets"] == 1
    assert client.get("/v1/accounts").json()[0]["opening_balance"] == 0
    assert client.get("/v1/budgets").json() == []


def test_wipe_all_data(client):
    _seed(client)

    res = client.post(
        "/v1/data/reset",
        json={"mode": "wipe", "confirm": "WIPE SEMUA"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["mode"] == "wipe"
    assert body["deleted"]["transactions"] == 1
    assert body["deleted"]["accounts"] == 1
    assert body["deleted"]["categories"] == 1
    assert body["deleted"]["budgets"] == 1

    assert client.get("/v1/accounts").json() == []
    assert client.get("/v1/categories").json() == []
    assert client.get("/v1/transactions?start=2026-01-01&end=2026-12-31").json() == []
    assert client.get("/v1/budgets").json() == []
    assert client.get("/v1/settings").json() == {
        "monthly_start_day": 1,
        "weekly_start_day": 1,
        "default_account_id": None,
    }
