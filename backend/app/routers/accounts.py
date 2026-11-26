"""Wallet/account routes."""
from datetime import datetime
from uuid import uuid4

from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from ..core.auth import owner
from ..core.config import JAKARTA
from ..core.db import get_db
from ..core.realtime import notify as realtime_notify
from ..models import Account
from ..schemas import AccountEdit, AccountIn
from ..services.accounts import (
    account_tx_count,
    balance,
    delete_account,
    edit_account,
    list_accounts_with_stats,
)
from ..services.common import columns

router = APIRouter(prefix="/v1", tags=["accounts"])


@router.get("/accounts")
def list_accounts(db: Session = Depends(get_db), user: str = Depends(owner)):
    return list_accounts_with_stats(db, user, datetime.now(JAKARTA).date())


@router.post("/accounts", status_code=201)
def add_account(data: AccountIn, db: Session = Depends(get_db), user: str = Depends(owner)):
    obj = Account(owner_id=user, **data.model_dump(exclude={"code"}), code=data.code or str(uuid4()))
    db.add(obj)
    db.commit()
    realtime_notify(user, "account:created")
    return {**columns(obj), "balance": balance(db, obj, datetime.now(JAKARTA).date()), "tx_count": 0}


@router.patch("/accounts/{key}")
def update_account_route(key: str, data: AccountEdit, db: Session = Depends(get_db), user: str = Depends(owner)):
    obj = edit_account(db, user, key, data)
    db.commit()
    realtime_notify(user, "account:updated")
    return {
        **columns(obj),
        "balance": balance(db, obj, datetime.now(JAKARTA).date()),
        "tx_count": account_tx_count(db, user, obj.id),
    }


@router.delete("/accounts/{key}", status_code=204)
def remove_account_route(
    key: str,
    transfer_to: str | None = None,
    cascade: bool = False,
    db: Session = Depends(get_db),
    user: str = Depends(owner),
):
    delete_account(db, user, key, transfer_to=transfer_to, cascade=cascade)
    db.commit()
    realtime_notify(user, "account:deleted")
    return Response(status_code=204)
