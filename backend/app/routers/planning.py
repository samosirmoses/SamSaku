"""Goals and income allocation scheme routes."""
from uuid import uuid4

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..core.auth import owner
from ..core.db import get_db, lock_owner
from ..models import Goal, Scheme
from ..schemas import ApplyIn, GoalIn, SchemeIn
from ..services.common import columns, owned
from ..services.planning import (
    list_goals_with_reserves,
    list_schemes_with_pots,
    plan_allocation,
    validate_scheme,
)

router = APIRouter(prefix="/v1", tags=["planning"])


@router.get("/goals")
def goals(db: Session = Depends(get_db), user: str = Depends(owner)):
    return list_goals_with_reserves(db, user)


@router.post("/goals", status_code=201)
def create_goal(data: GoalIn, db: Session = Depends(get_db), user: str = Depends(owner)):
    obj = Goal(owner_id=user, **data.model_dump())
    db.add(obj)
    db.commit()
    return {**columns(obj), "reserved": 0}


@router.get("/schemes")
def schemes(db: Session = Depends(get_db), user: str = Depends(owner)):
    return list_schemes_with_pots(db, user)


@router.post("/schemes", status_code=201)
def create_scheme(data: SchemeIn, db: Session = Depends(get_db), user: str = Depends(owner)):
    validate_scheme(db, user, data)
    obj = Scheme(owner_id=user, **data.model_dump(exclude={"code"}), code=data.code or str(uuid4()))
    db.add(obj)
    db.commit()
    return columns(obj)


@router.put("/schemes/{key}")
def update_scheme(key: str, data: SchemeIn, db: Session = Depends(get_db), user: str = Depends(owner)):
    lock_owner(db, user)
    obj = owned(db, Scheme, user, key)
    validate_scheme(db, user, data)
    obj.name, obj.cycle_day, obj.rules = data.name, data.cycle_day, data.model_dump()["rules"]
    db.commit()
    return columns(obj)


@router.post("/schemes/{key}/preview")
def preview(key: str, data: ApplyIn, db: Session = Depends(get_db), user: str = Depends(owner)):
    return plan_allocation(db, user, key, data)


@router.post("/schemes/{key}/apply")
def apply_scheme(key: str, data: ApplyIn, db: Session = Depends(get_db), user: str = Depends(owner)):
    result = plan_allocation(db, user, key, data, persist=True)
    db.commit()
    return result
