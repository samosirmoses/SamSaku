from datetime import date
import json

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, select, func
from sqlalchemy.orm import Session

from app.db import Base
from app.ledger import post_transaction, balance, summary
from app.intake import ingest
from app.models import Account, Category, Transaction, Scheme, Reserve, Evidence
from app.planning import plan_allocation
from app.schemas import ApplyIn, EventIn, TransactionIn

OWNER = "u1"
DAY = date(2026, 1, 25)


@pytest.fixture
def db():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        for code in ["BCA", "GOPAY"]:
            session.add(Account(id=code, owner_id=OWNER, name=code, code=code, opening_date=DAY, opening_balance=0))
        session.add(Category(id="FOOD", owner_id=OWNER, name="Makanan", code="FOOD", kind="expense"))
        session.commit()
        yield session


def post(db, kind, amount, **fields):
    data = {"date": DAY, "account_id": "BCA", "kind": kind, "amount": amount, **fields}
    return post_transaction(db, OWNER, TransactionIn(**data))


def test_transfer_fee_and_old_history(db):
    post(db, "expense", 300000, date=date(2026,1,23))
    post(db, "transfer", 100000, to_account_id="GOPAY", fee=1000)
    assert balance(db, db.get(Account,"BCA")) == -101000
    assert balance(db, db.get(Account,"GOPAY")) == 100000
    assert summary(db,OWNER,DAY,DAY)["expense"] == 1000


def test_split_and_refund_do_not_double_count(db):
    tx = post(db, "expense", 100000, splits=[{"category_id":"FOOD","amount":100000}], source_ref="expense01")
    same = post(db, "expense", 100000, splits=[{"category_id":"FOOD","amount":100000}], source_ref="expense01")
    assert same.id == tx.id
    feb = date(2026,2,3)
    post(db, "refund", 30000, original_id=tx.id, date=feb)
    feb_summary = summary(db, OWNER, feb, feb)
    assert (feb_summary["expense"], feb_summary["income"]) == (-30000,0)
    with pytest.raises(HTTPException):
        post(db,"refund",80000,original_id=tx.id,date=feb)
    assert balance(db,db.get(Account,"BCA")) == -70000


def test_allocation_and_double_click(db, monkeypatch):
    monkeypatch.setattr("app.planning.today", lambda: DAY)
    income = post(db, "income", 10000000)
    post(db, "expense", 2000000)
    rules = [{"name":n,"mode":m,"value":v} for n,m,v in [
        ("Keluarga","fixed",1500000), ("Darurat","percent",20), ("Harian","percent",45), ("Bebas","remainder",0)]]
    rules[2]["category_ids"] = ["FOOD"]
    scheme = Scheme(owner_id=OWNER,name="Gajian",code="PAY",cycle_day=25,rules=rules)
    db.add(scheme)
    db.flush()
    request = ApplyIn(date=DAY,request_id="abc",income_ids=[income.id])
    quote = plan_allocation(db,OWNER,scheme.id,request)
    request = request.model_copy(update={"revision":quote["revision"]})
    assert [r["amount"] for r in quote["items"]] == [1500000,1600000,3600000,1300000]
    assert plan_allocation(db,OWNER,scheme.id,request,True) == quote
    assert plan_allocation(db,OWNER,scheme.id,request,True) == quote
    assert db.scalar(select(func.count()).select_from(Reserve)) == 4
    post(db, "expense", 50000, category_id="FOOD")
    assert db.scalar(select(Reserve.remaining).where(Reserve.pot_name=="Harian")) == 3550000


def test_verified_template_and_duplicate_event(db, tmp_path, monkeypatch):
    rule = {"source":"bca","account_code":"BCA","verified":True,"use_delivery_date":True,"kind":"expense",
            "pattern":r"Pembayaran berhasil Rp(?P<amount>[\d.]+) di (?P<merchant>\w+) Ref (?P<ref>\w+)"}
    path = tmp_path / "rules.json"
    path.write_text(json.dumps([rule]),encoding="utf-8")
    monkeypatch.setenv("SAMSAKU_PARSER_RULES",str(path))
    data = EventIn(external_id="123",text="Pembayaran berhasil Rp35.000 di Kopi Ref ABC123")
    event = ingest(db, OWNER, "bca", data)
    assert event.status == "posted"
    assert ingest(db,OWNER,"bca",data).id == event.id
    second = ingest(db,OWNER,"bca",data.model_copy(update={"external_id":"456"}))
    assert second.transaction_id == event.transaction_id
    assert db.scalar(select(func.count()).select_from(Transaction)) == 1
    uncertain = ingest(db,OWNER,"gopay",EventIn(external_id="y",text="Silakan cek transaksi Anda"))
    assert uncertain.status == "review"


def test_reference_cannot_be_reused_for_other_amount(db):
    post(db,"expense",20000,source_ref="123")
    with pytest.raises(HTTPException) as err:
        post(db,"expense",40000,source_ref="123")
    assert err.value.status_code == 409
