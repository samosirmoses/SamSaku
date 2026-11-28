"""Wallet/account routes."""
from datetime import datetime

from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from ..core.auth import owner
from ..core.config import JAKARTA
from ..core.db import get_db
from ..core.realtime import notify as realtime_notify
from ..schemas import AccountEdit, AccountIn
from ..services.accounts import (
    create_account,
    delete_account,
    list_accounts_with_stats,
    update_account_with_stats,
)

router = APIRouter(prefix="/v1", tags=["accounts"])


@router.get("/accounts")
def list_accounts(db: Session = Depends(get_db), user: str = Depends(owner)):
    return list_accounts_with_stats(db, user, datetime.now(JAKARTA).date())


@router.post("/accounts", status_code=201)
def add_account(data: AccountIn, db: Session = Depends(get_db), user: str = Depends(owner)):
    payload = create_account(db, user, data, datetime.now(JAKARTA).date())
    db.commit()
    realtime_notify(user, "account:created")
    return payload


@router.patch("/accounts/{key}")
def update_account_route(key: str, data: AccountEdit, db: Session = Depends(get_db), user: str = Depends(owner)):
    payload = update_account_with_stats(db, user, key, data, datetime.now(JAKARTA).date())
    db.commit()
    realtime_notify(user, "account:updated")
    return payload


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
