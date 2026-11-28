"""Transaction routes with batched serialization and Idempotency-Key support."""
from datetime import date

from fastapi import APIRouter, Depends, Header, HTTPException, Response
from sqlalchemy.orm import Session

from ..core.auth import owner
from ..core.db import get_db
from ..core.realtime import notify as realtime_notify
from ..schemas import TransactionIn
from ..services.transactions import (
    delete_transaction,
    post_transaction_with_status,
    serialize_transactions,
    transaction_dict,
    transactions,
    update_transaction,
)

router = APIRouter(prefix="/v1", tags=["transactions"])


@router.get("/transactions")
def list_tx(
    start: date | None = None,
    end: date | None = None,
    db: Session = Depends(get_db),
    user: str = Depends(owner),
):
    tx_rows = transactions(db, user, start or date.min, end or date.max)
    return serialize_transactions(db, user, tx_rows)


@router.post("/transactions", status_code=201)
def add_tx(
    data: TransactionIn,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    db: Session = Depends(get_db),
    user: str = Depends(owner),
):
    header_ref = idempotency_key.strip() if idempotency_key and idempotency_key.strip() else None
    if header_ref and len(header_ref) > 512:
        raise HTTPException(422, "Idempotency-Key maksimal 512 karakter.")
    tx, created = post_transaction_with_status(db, user, data, source_ref=data.source_ref or header_ref)
    db.commit()
    if created:
        realtime_notify(user, "transaction:created")
    return transaction_dict(db, tx)


@router.put("/transactions/{key}")
@router.patch("/transactions/{key}")
def edit_tx(key: str, data: TransactionIn, db: Session = Depends(get_db), user: str = Depends(owner)):
    tx = update_transaction(db, user, key, data)
    db.commit()
    realtime_notify(user, "transaction:updated")
    return transaction_dict(db, tx)


@router.delete("/transactions/{key}", status_code=204)
def remove_tx(key: str, db: Session = Depends(get_db), user: str = Depends(owner)):
    delete_transaction(db, user, key)
    db.commit()
    realtime_notify(user, "transaction:deleted")
    return Response(status_code=204)
