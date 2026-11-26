"""Shared repository and serialization helpers for owner-scoped entities."""
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session


def fail(message: str):
    raise HTTPException(422, message)


def owned(db: Session, model, owner_id: str, key: str):
    row = db.get(model, key)
    if row is None or row.owner_id != owner_id:
        raise HTTPException(404, "Data tidak ditemukan.")
    return row


def rows(db: Session, model, owner_id: str):
    return db.scalars(select(model).where(model.owner_id == owner_id))


def columns(row) -> dict:
    return {col.name: getattr(row, col.name) for col in row.__table__.columns if col.name != "owner_id"}
