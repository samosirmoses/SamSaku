"""Category routes."""
from uuid import uuid4

from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from ..core.auth import owner
from ..core.db import get_db
from ..core.realtime import notify as realtime_notify
from ..models import Category
from ..schemas import CategoryEdit, CategoryIn
from ..services.categories import delete_category, edit_category_item
from ..services.common import columns, fail, owned, rows

router = APIRouter(prefix="/v1", tags=["categories"])


@router.get("/categories")
def list_categories(db: Session = Depends(get_db), user: str = Depends(owner)):
    return [columns(c) for c in rows(db, Category, user)]


@router.post("/categories", status_code=201)
def add_category(data: CategoryIn, db: Session = Depends(get_db), user: str = Depends(owner)):
    if data.parent_id:
        parent = owned(db, Category, user, data.parent_id)
        if parent.kind != data.kind or parent.parent_id or parent.archived:
            fail("Induk harus kategori utama aktif dengan tipe yang sama.")
    obj = Category(owner_id=user, **data.model_dump(exclude={"code"}), code=data.code or str(uuid4()))
    db.add(obj)
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
