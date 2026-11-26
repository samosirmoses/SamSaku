"""Financial summary route."""
from datetime import date

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..core.auth import owner
from ..core.db import get_db
from ..services.settings import resolve_period
from ..services.summary import summary

router = APIRouter(prefix="/v1", tags=["summary"])


@router.get("/summary")
def overview(
    start: date | None = None,
    end: date | None = None,
    db: Session = Depends(get_db),
    user: str = Depends(owner),
):
    return summary(db, user, *resolve_period(start, end, db, user))
