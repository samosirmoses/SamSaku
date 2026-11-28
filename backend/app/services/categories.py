"""Category CRUD and hierarchy validation."""
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from ..core.db import lock_owner
from ..models import Budget, Category, Reserve, ReserveMovement, Scheme, Split, Transaction
from ..schemas import CategoryEdit, CategoryIn
from .common import columns, fail, owned, rows


def list_categories(db: Session, owner_id: str) -> list[dict]:
    return [columns(c) for c in rows(db, Category, owner_id)]


def create_category_item(db: Session, owner_id: str, data: CategoryIn) -> Category:
    lock_owner(db, owner_id)
    if data.parent_id:
        parent = owned(db, Category, owner_id, data.parent_id)
        if parent.kind != data.kind or parent.parent_id or parent.archived:
            fail("Induk harus kategori utama aktif dengan tipe yang sama.")
    obj = Category(owner_id=owner_id, **data.model_dump(exclude={"code"}), code=data.code or str(uuid4()))
    db.add(obj)
    db.flush()
    return obj


def _is_category_referenced(db: Session, owner_id: str, category_id: str) -> bool:
    for model, col in (
        (Category, Category.parent_id),
        (Transaction, Transaction.category_id),
        (Split, Split.category_id),
        (Budget, Budget.category_id),
        (ReserveMovement, ReserveMovement.category_id),
    ):
        if db.scalar(select(model.id).where(model.owner_id == owner_id, col == category_id).limit(1)):
            return True
    for scheme in db.scalars(select(Scheme).where(Scheme.owner_id == owner_id)).all():
        if any(category_id in (rule.get("category_ids") or []) for rule in (scheme.rules or [])):
            return True
    for reserve in db.scalars(select(Reserve).where(Reserve.owner_id == owner_id)).all():
        if category_id in (reserve.category_ids or []):
            return True
    return False


def edit_category_item(db: Session, owner_id: str, key: str, data: CategoryEdit) -> Category:
    lock_owner(db, owner_id)
    obj = owned(db, Category, owner_id, key)
    new_kind = data.kind or obj.kind
    if data.kind is not None and data.kind != obj.kind:
        if _is_category_referenced(db, owner_id, obj.id):
            raise HTTPException(409, "Jenis kategori tidak dapat diubah karena sudah digunakan.")
        if "parent_id" not in data.model_fields_set and obj.parent_id:
            parent = owned(db, Category, owner_id, obj.parent_id)
            if parent.kind != new_kind or parent.parent_id or parent.archived:
                fail("Induk harus kategori utama aktif dengan tipe yang sama.")
    if "parent_id" in data.model_fields_set:
        if data.parent_id:
            if data.parent_id == obj.id:
                fail("Kategori tidak bisa menjadi induk bagi dirinya sendiri.")
            parent = owned(db, Category, owner_id, data.parent_id)
            if parent.kind != new_kind or parent.parent_id or parent.archived:
                fail("Induk harus kategori utama aktif dengan tipe yang sama.")
            has_children = db.scalar(
                select(Category.id)
                .where(Category.owner_id == owner_id, Category.parent_id == obj.id)
                .limit(1)
            )
            if has_children:
                fail("Kategori ini memiliki subkategori dan harus tetap menjadi kategori utama.")
        obj.parent_id = data.parent_id
    if data.name is not None:
        obj.name = data.name
    if data.kind is not None:
        obj.kind = data.kind
    if data.archived is not None:
        obj.archived = data.archived
    db.flush()
    return obj


def _remap_id_list(items: list[str] | None, old_id: str, target_id: str | None) -> tuple[list[str], bool]:
    if not items or old_id not in items:
        return list(items or []), False
    updated: list[str] = []
    seen: set[str] = set()
    for cid in items:
        mapped = target_id if cid == old_id else cid
        if mapped and mapped not in seen:
            seen.add(mapped)
            updated.append(mapped)
    return updated, True


def delete_category(db: Session, owner_id: str, key: str, transfer_to: str | None = None) -> None:
    lock_owner(db, owner_id)
    cat = owned(db, Category, owner_id, key)
    target_id = None
    target_parent_id = None
    if transfer_to:
        if transfer_to == key:
            fail("Kategori pengganti harus berbeda.")
        target = owned(db, Category, owner_id, transfer_to)
        if target.kind != cat.kind:
            fail("Kategori pengganti harus memiliki jenis yang sama.")
        target_id = target.id
        target_parent_id = target.parent_id
    db.execute(
        update(Category)
        .where(Category.owner_id == owner_id, Category.parent_id == key)
        .values(parent_id=target_id if (target_id and not target_parent_id) else None)
    )
    db.execute(
        update(Transaction)
        .where(Transaction.owner_id == owner_id, Transaction.category_id == key)
        .values(category_id=target_id)
    )
    db.execute(
        update(Split)
        .where(Split.owner_id == owner_id, Split.category_id == key)
        .values(category_id=target_id)
    )
    if target_id:
        db.execute(
            update(ReserveMovement)
            .where(ReserveMovement.owner_id == owner_id, ReserveMovement.category_id == key)
            .values(category_id=target_id)
        )
    else:
        movements = list(
            db.scalars(
                select(ReserveMovement).where(
                    ReserveMovement.owner_id == owner_id,
                    ReserveMovement.category_id == key,
                )
            ).all()
        )
        for mv in movements:
            reserve = db.get(Reserve, mv.reserve_id)
            if reserve and reserve.owner_id == owner_id:
                reserve.remaining = max(0, min(reserve.amount, reserve.remaining + mv.amount))
        if movements:
            db.execute(
                delete(ReserveMovement).where(
                    ReserveMovement.owner_id == owner_id,
                    ReserveMovement.category_id == key,
                )
            )
    for scheme in db.scalars(select(Scheme).where(Scheme.owner_id == owner_id)).all():
        changed = False
        new_rules = []
        for rule in scheme.rules or []:
            rule_copy = dict(rule)
            new_cats, rule_changed = _remap_id_list(rule_copy.get("category_ids"), key, target_id)
            if rule_changed:
                rule_copy["category_ids"] = new_cats
                changed = True
            new_rules.append(rule_copy)
        if changed:
            scheme.rules = new_rules
    for reserve in db.scalars(select(Reserve).where(Reserve.owner_id == owner_id)).all():
        new_cats, res_changed = _remap_id_list(reserve.category_ids, key, target_id)
        if res_changed:
            reserve.category_ids = new_cats
    db.execute(delete(Budget).where(Budget.owner_id == owner_id, Budget.category_id == key))
    db.flush()
    db.delete(cat)
    db.flush()
