"""Goals and income allocation scheme routes."""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..core.auth import owner
from ..core.db import get_db
from ..schemas import ApplyIn, GoalIn, SchemeIn
from ..services.planning import (
    create_goal_item,
    create_scheme_item,
    delete_goal_item,
    list_goals_with_reserves,
    list_schemes_with_pots,
    plan_allocation,
    update_scheme_item,
)

router = APIRouter(prefix="/v1", tags=["planning"])


@router.get("/goals")
def goals(db: Session = Depends(get_db), user: str = Depends(owner)):
    return list_goals_with_reserves(db, user)


@router.post("/goals", status_code=201)
def create_goal(data: GoalIn, db: Session = Depends(get_db), user: str = Depends(owner)):
    result = create_goal_item(db, user, data)
    db.commit()
    return result


@router.delete("/goals/{key}", status_code=204)
def delete_goal(key: str, db: Session = Depends(get_db), user: str = Depends(owner)):
    delete_goal_item(db, user, key)
    db.commit()


@router.get("/schemes")
def schemes(db: Session = Depends(get_db), user: str = Depends(owner)):
    return list_schemes_with_pots(db, user)


@router.post("/schemes", status_code=201)
def create_scheme(data: SchemeIn, db: Session = Depends(get_db), user: str = Depends(owner)):
    result = create_scheme_item(db, user, data)
    db.commit()
    return result


@router.put("/schemes/{key}")
def update_scheme(key: str, data: SchemeIn, db: Session = Depends(get_db), user: str = Depends(owner)):
    result = update_scheme_item(db, user, key, data)
    db.commit()
    return result


@router.post("/schemes/{key}/preview")
def preview(key: str, data: ApplyIn, db: Session = Depends(get_db), user: str = Depends(owner)):
    return plan_allocation(db, user, key, data)


@router.post("/schemes/{key}/apply")
def apply_scheme(key: str, data: ApplyIn, db: Session = Depends(get_db), user: str = Depends(owner)):
    result = plan_allocation(db, user, key, data, persist=True)
    db.commit()
    return result
