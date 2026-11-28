"""Evidence review queue, connector activity status, and external event ingestion service."""
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..core.db import lock_owner
from ..models import Evidence, Transaction
from ..schemas import EventIn, ResolveIn
from .common import columns, fail, owned
from .intake import ingest_with_status
from .transactions import post_transaction, transaction_matches_input


def list_reviews(db: Session, owner_id: str) -> list[dict]:
    return [
        columns(i)
        for i in db.scalars(
            select(Evidence)
            .where(Evidence.owner_id == owner_id, Evidence.status == "review")
            .order_by(Evidence.occurred_at.desc())
        )
    ]


def list_connections(db: Session, owner_id: str) -> list[dict]:
    latest = dict(
        db.execute(
            select(Evidence.source, func.max(Evidence.received_at))
            .where(Evidence.owner_id == owner_id)
            .group_by(Evidence.source)
        ).all()
    )
    return [{"source": source, "last_received_at": latest.get(source)} for source in ("bca", "gopay", "telegram")]


def resolve_review(db: Session, owner_id: str, key: str, data: ResolveIn) -> tuple[dict, bool]:
    lock_owner(db, owner_id)
    item = owned(db, Evidence, owner_id, key)
    if item.status != "review":
        if data.action == "ignore":
            if item.status == "ignored":
                return columns(item), False
        elif data.action == "link":
            if not data.transaction_id:
                fail("Pilih transaksi yang akan ditautkan.")
            if item.status == "linked" and item.transaction_id == data.transaction_id:
                return columns(item), False
        elif data.action == "post":
            if not data.transaction:
                fail("Lengkapi transaksi sebelum menyimpan.")
            if item.status == "posted" and item.transaction_id:
                tx = db.get(Transaction, item.transaction_id)
                if tx and tx.owner_id == owner_id and transaction_matches_input(db, owner_id, tx, data.transaction):
                    return columns(item), False
        raise HTTPException(409, "Bukti sudah diselesaikan dengan tindakan atau data berbeda.")

    if data.action == "link":
        if not data.transaction_id:
            fail("Pilih transaksi yang akan ditautkan.")
        item.transaction_id = owned(db, Transaction, owner_id, data.transaction_id).id
        item.status = "linked"
    elif data.action == "post":
        if not data.transaction:
            fail("Lengkapi transaksi sebelum menyimpan.")
        ref = data.transaction.source_ref or item.parsed.get("source_ref") or f"event:{item.id}"
        tx = post_transaction(db, owner_id, data.transaction, item.source, ref)
        item.transaction_id, item.status = tx.id, "posted"
    else:
        item.status = "ignored"
    db.flush()
    return columns(item), True


def ingest_event(db: Session, owner_id: str, source: str, data: EventIn) -> tuple[dict, bool]:
    result, created = ingest_with_status(db, owner_id, source, data)
    return {
        "id": result.id,
        "status": result.status,
        "transaction_id": result.transaction_id,
        "parsed": result.parsed,
    }, created
