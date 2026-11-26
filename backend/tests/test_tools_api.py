from datetime import date
from io import BytesIO

import pytest
from fastapi import HTTPException
from openpyxl import Workbook
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

from app.core.db import Base
from app.models import Account, Category, ImportEntry, Transaction
from app.routers.tools import commit, preview
from app.schemas import Commit, Preview, RowKey, SheetMap
from app.services.accounts import balance
from app.services.jobs import store_file
from app.services.receipt_text import extract, infer_category
from app.services.reports import report_csv
from app.services.summary import summary

OWNER = "test-owner"


@pytest.fixture
def db():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session


def job(db, sheets, kind):
    book = Workbook()
    book.remove(book.active)
    for name, lines in sheets.items():
        ws = book.create_sheet(name)
        for line in lines:
            ws.append(line)
    data = BytesIO()
    book.save(data)
    item = store_file(db, OWNER, kind, "sam.xlsx", data.getvalue())
    db.commit()
    return item.id


def test_master_parent_below_child_and_retry(db):
    batch = job(
        db,
        {"categories": [["code", "name", "kind", "parent"], ["KOPI", "Kopi", "expense", "FOOD"], ["FOOD", "Makanan", "expense"]]},
        "masters",
    )
    plan = Preview(sheets=[SheetMap(name="categories", entity="categories")])
    result = preview(batch, plan, OWNER, db)
    assert result["counts"] == {"new": 2}
    assert db.scalar(select(func.count()).select_from(Category)) == 0
    confirm = Commit(revision=result["revision"])
    assert commit(batch, confirm, OWNER, db)["applied"] == 2
    assert commit(batch, confirm, OWNER, db)["applied"] == 2
    assert db.scalar(select(func.count()).select_from(ImportEntry)) == 2
    child = db.scalar(select(Category).where(Category.code == "KOPI"))
    assert db.get(Category, child.parent_id).name == "Makanan"


def test_anchor_split_and_similar_requires_consent(db):
    bca = Account(owner_id=OWNER, name="BCA", code="BCA", opening_balance=5000000, opening_date=date(2026, 1, 1))
    db.add(bca)
    db.commit()
    lines = [
        ["date", "kind", "amount", "account", "reference"],
        ["2025-12-20", "expense", 300000, "BCA", "A"],
        ["2026-01-01", "expense", 35000, "BCA", "B"],
        ["2026-01-01", "expense", 35000, "BCA", "C"],
    ]
    batch = job(db, {"transactions": lines}, "transactions")
    result = preview(batch, Preview(sheets=[SheetMap(name="transactions", entity="transactions")]), OWNER, db)
    assert result["expense"] == 370000
    assert result["impacts"] == {"BCA": -70000}
    assert result["counts"] == {"new": 2, "similar": 1}
    with pytest.raises(HTTPException):
        commit(batch, Commit(revision=result["revision"]), OWNER, db)
    assert db.scalar(select(func.count()).select_from(Transaction)) == 0
    args = Commit(revision=result["revision"], accept_similar=[RowKey(sheet="transactions", row=4)])
    commit(batch, args, OWNER, db)
    assert balance(db, bca) == 4930000
    report = summary(db, OWNER, date(2025, 12, 1), date(2026, 1, 31))
    assert report["expense"] == 370000
    assert report_csv(report).decode("utf-8-sig").count("\r\n") == 4


def test_receipt_chooses_total_and_handles_ambiguity():
    txt = "Kopi Senja\n12/11/2026\nSubtotal Rp40.000\nTOTAL Rp42.000\nTunai Rp50.000\nKembali Rp8.000"
    assert extract(txt) == {"amount": 42000, "date": "2026-11-12", "merchant": "Kopi Senja", "amount_options": [42000]}
    assert extract(txt + "\nTotal Rp43.000")["amount"] is None
    cats = [
        {"id": "c-food", "name": "Makan & minum", "kind": "expense", "archived": False},
        {"id": "c-shop", "name": "Belanja", "kind": "expense", "archived": False},
        {"id": "c-trans", "name": "Transportasi", "kind": "expense", "archived": False},
    ]
    assert infer_category(cats, [], txt, "Kopi Senja") == ("c-food", "Makan & minum")
    assert infer_category(cats, [], "Indomaret\n24 Nov 2026\nTotal Belanja Rp 55.000", "Indomaret") == ("c-shop", "Belanja")
    assert infer_category(cats, [], "SPBU Pertamina\nPertamax Rp 150.000", "SPBU Pertamina") == ("c-trans", "Transportasi")
