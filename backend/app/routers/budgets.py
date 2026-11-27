"""Budget and user settings routes."""
from datetime import date

from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from ..core.auth import owner
from ..core.db import get_db
from ..core.realtime import notify as realtime_notify
from ..schemas import BudgetIn, DataResetIn, SettingsIn
from ..services.settings import get_settings, reset_owner_data, resolve_period, update_settings
from ..services.summary import delete_budget, list_budgets, upsert_budget

router = APIRouter(prefix="/v1", tags=["budgets-settings"])


@router.get("/settings")
def read_settings(db: Session = Depends(get_db), user: str = Depends(owner)):
    return get_settings(db, user)


@router.put("/settings")
def save_settings(data: SettingsIn, db: Session = Depends(get_db), user: str = Depends(owner)):
    result = update_settings(db, user, data)
    db.commit()
    realtime_notify(user, "settings:updated")
    return result


@router.post("/data/reset")
def reset_data(data: DataResetIn, db: Session = Depends(get_db), user: str = Depends(owner)):
    result = reset_owner_data(db, user, data)
    db.commit()
    realtime_notify(user, "data:reset")
    return result


@router.get("/budgets")
def read_budgets(
    start: date | None = None,
    end: date | None = None,
    db: Session = Depends(get_db),
    user: str = Depends(owner),
):
    return list_budgets(db, user, *resolve_period(start, end, db, user))


@router.post("/budgets", status_code=201)
def save_budget(data: BudgetIn, db: Session = Depends(get_db), user: str = Depends(owner)):
    result = upsert_budget(db, user, data)
    db.commit()
    realtime_notify(user, "budget:updated")
    return result


@router.delete("/budgets/{key}", status_code=204)
def remove_budget(key: str, db: Session = Depends(get_db), user: str = Depends(owner)):
    delete_budget(db, user, key)
    db.commit()
    realtime_notify(user, "budget:deleted")
    return Response(status_code=204)
