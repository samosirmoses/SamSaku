"""Single-request bootstrap endpoint replacing the 7-request frontend waterfall."""
from datetime import date

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..core.auth import owner
from ..core.db import get_db
from ..services.bootstrap import build_bootstrap

router = APIRouter(prefix="/v1", tags=["bootstrap"])


@router.get("/bootstrap")
def bootstrap(
    month: str | None = None,
    start: date | None = None,
    end: date | None = None,
    db: Session = Depends(get_db),
    user: str = Depends(owner),
):
    return build_bootstrap(db, user, month=month, start=start, end=end)
