"""Uses the already-migrated disposable Postgres database supplied by CI."""
from concurrent.futures import ThreadPoolExecutor
from datetime import date
import os
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.orm import Session

from app.ledger import post_transaction
from app.models import Account, Transaction
from app.schemas import TransactionIn


@pytest.mark.skipif(not os.getenv("SAMSAKU_TEST_POSTGRES"), reason="Requires a disposable migrated PostgreSQL database")
def test_parallel_post_and_private_tables():
    engine = create_engine(os.environ["SAMSAKU_TEST_POSTGRES"])
    owner_id, account_id = str(uuid4()), str(uuid4())
    try:
        with Session(engine) as db:
            db.add(Account(id=account_id, owner_id=owner_id, name="Dompet", code="W"))
            db.commit()
            secured = set(db.scalars(text("""
                select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
                where n.nspname='public' and c.relrowsecurity
            """)))
            assert {"transactions","reserves","file_jobs","import_entries","source_events"} <= secured

        def worker():
            with Session(engine) as db:
                entry = TransactionIn(date=date.today(),kind="expense",account_id=account_id,
                                      amount=12345,source_ref="same-key")
                tx = post_transaction(db,owner_id,entry)
                key = tx.id
                db.commit()
                return key

        with ThreadPoolExecutor(max_workers=3) as executor:
            assert len(set(executor.map(lambda _: worker(), range(3)))) == 1
        with Session(engine) as db:
            assert db.scalar(select(func.count()).select_from(Transaction).where(Transaction.owner_id==owner_id)) == 1
    finally:
        engine.dispose()
