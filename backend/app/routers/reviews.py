"""Evidence review queue, connector activity status, and external event ingestion routes."""
from typing import Literal

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..core.auth import configured_owner, owner, secret_matches
from ..core.db import get_db, lock_owner
from ..core.realtime import notify as realtime_notify
from ..models import Evidence, Transaction
from ..schemas import EventIn, ResolveIn
from ..services.common import columns, fail, owned
from ..services.intake import ingest
from ..services.transactions import post_transaction

router = APIRouter(prefix="/v1", tags=["reviews-events"])


@router.get("/reviews")
def reviews(db: Session = Depends(get_db), user: str = Depends(owner)):
    return [
        columns(i)
        for i in db.scalars(
            select(Evidence)
            .where(Evidence.owner_id == user, Evidence.status == "review")
            .order_by(Evidence.occurred_at.desc())
        )
    ]


@router.get("/connections")
def connections(db: Session = Depends(get_db), user: str = Depends(owner)):
    latest = dict(
        db.execute(
            select(Evidence.source, func.max(Evidence.received_at))
            .where(Evidence.owner_id == user)
            .group_by(Evidence.source)
        ).all()
    )
    return [{"source": source, "last_received_at": latest.get(source)} for source in ("bca", "gopay", "telegram")]


@router.post("/reviews/{key}/resolve")
def review(key: str, data: ResolveIn, db: Session = Depends(get_db), user: str = Depends(owner)):
    lock_owner(db, user)
    item = owned(db, Evidence, user, key)
    if item.status != "review":
        return columns(item)
    if data.action == "link":
        if not data.transaction_id:
            fail("Pilih transaksi yang akan ditautkan.")
        item.transaction_id = owned(db, Transaction, user, data.transaction_id).id
        item.status = "linked"
    elif data.action == "post":
        if not data.transaction:
            fail("Lengkapi transaksi sebelum menyimpan.")
        ref = data.transaction.source_ref or item.parsed.get("source_ref") or f"event:{item.id}"
        tx = post_transaction(db, user, data.transaction, item.source, ref)
        item.transaction_id, item.status = tx.id, "posted"
    else:
        item.status = "ignored"
    db.commit()
    realtime_notify(user, "review:resolved")
    return columns(item)


@router.post("/events/{source}")
def event(
    source: Literal["bca", "gopay", "telegram"],
    data: EventIn,
    authorization: str = Header(""),
    db: Session = Depends(get_db),
):
    if not authorization.startswith("Bearer ") or not secret_matches(authorization[7:], source.upper() + "_TOKEN"):
        raise HTTPException(401, "Kredensial konektor tidak valid.")
    owner_id = configured_owner()
    result = ingest(db, owner_id, source, data)
    db.commit()
    label = "myBCA" if source == "bca" else source.upper()
    realtime_notify(owner_id, f"event:{source}", f"Mutasi baru masuk dari {label}.")
    return {"id": result.id, "status": result.status, "transaction_id": result.transaction_id, "parsed": result.parsed}
