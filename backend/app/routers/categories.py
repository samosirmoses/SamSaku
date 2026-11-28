"""Category routes."""
from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from ..core.auth import owner
from ..core.db import get_db
from ..core.realtime import notify as realtime_notify
from ..schemas import CategoryEdit, CategoryIn
from ..services.categories import (
    create_category_item,
    delete_category,
    edit_category_item,
    list_categories,
)
from ..services.common import columns

router = APIRouter(prefix="/v1", tags=["categories"])


@router.get("/categories")
def list_categories_route(db: Session = Depends(get_db), user: str = Depends(owner)):
    return list_categories(db, user)


@router.post("/categories", status_code=201)
def add_category(data: CategoryIn, db: Session = Depends(get_db), user: str = Depends(owner)):
    obj = create_category_item(db, user, data)
    db.commit()
    realtime_notify(user, "category:created")
    return columns(obj)


@router.patch("/categories/{key}")
def edit_category(key: str, data: CategoryEdit, db: Session = Depends(get_db), user: str = Depends(owner)):
    obj = edit_category_item(db, user, key, data)
    db.commit()
    realtime_notify(user, "category:updated")
    return columns(obj)


@router.delete("/categories/{key}", status_code=204)
def remove_category(
    key: str,
    transfer_to: str | None = None,
    db: Session = Depends(get_db),
    user: str = Depends(owner),
):
    delete_category(db, user, key, transfer_to=transfer_to)
    db.commit()
    realtime_notify(user, "category:deleted")
    return Response(status_code=204)
