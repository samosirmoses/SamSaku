"""Persistent file job and import provenance ORM models."""
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from sqlalchemy import DateTime, Integer, JSON, LargeBinary, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from ..core.db import Base


def job_now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class FileJob(Base):
    __tablename__ = "file_jobs"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    owner_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    kind: Mapped[str] = mapped_column(String(24), nullable=False)
    filename: Mapped[str] = mapped_column(String(180), nullable=False)
    digest: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="uploaded")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=job_now)
    expires_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=lambda: job_now() + timedelta(hours=24)
    )
    data: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    object_key: Mapped[str | None] = mapped_column(String(160), nullable=True)
    config: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    result: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class ImportEntry(Base):
    __tablename__ = "import_entries"
    __table_args__ = (UniqueConstraint("job_id", "sheet", "row"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    owner_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    job_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    sheet: Mapped[str] = mapped_column(String(80), nullable=False)
    row: Mapped[int] = mapped_column(Integer, nullable=False)
    entity: Mapped[str] = mapped_column(String(32), nullable=False)
    record_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
