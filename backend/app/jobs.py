"""Persistent inputs and state for finite, repeatable import and OCR requests."""
import hashlib
import os
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import httpx
from fastapi import HTTPException
from sqlalchemy import Column, DateTime, Integer, JSON, LargeBinary, String, UniqueConstraint, select

from .db import Base


def now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


class FileJob(Base):
    __tablename__ = "file_jobs"
    id = Column(String(36), primary_key=True, default=lambda: str(uuid4()))
    owner_id = Column(String(64), nullable=False, index=True)
    kind = Column(String(24), nullable=False)
    filename = Column(String(180), nullable=False)
    digest = Column(String(64), nullable=False)
    status = Column(String(24), nullable=False, default="uploaded")
    created_at = Column(DateTime, nullable=False, default=now)
    expires_at = Column(DateTime, nullable=False, default=lambda: now() + timedelta(hours=24))
    data = Column(LargeBinary, nullable=True)
    object_key = Column(String(160), nullable=True)
    config = Column(JSON, nullable=True)
    result = Column(JSON, nullable=True)


class ImportEntry(Base):
    __tablename__ = "import_entries"
    id = Column(Integer, primary_key=True)
    owner_id = Column(String(64), nullable=False, index=True)
    job_id = Column(String(36), nullable=False, index=True)
    sheet = Column(String(80), nullable=False)
    row = Column(Integer, nullable=False)
    entity = Column(String(32), nullable=False)
    record_id = Column(String(40), nullable=True)
    __table_args__ = (UniqueConstraint("job_id", "sheet", "row"),)


def storage_url(key):
    url = os.getenv("SUPABASE_URL", "").rstrip("/")
    bucket = os.getenv("FILE_STORAGE_BUCKET", "")
    secret = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    if not (url and bucket and secret):
        raise RuntimeError("Konfigurasi penyimpanan privat belum lengkap.")
    return f"{url}/storage/v1/object/{bucket}/{key}", {"Authorization": f"Bearer {secret}", "apikey": secret}


def store_file(db, owner, kind, filename, content):
    digest = hashlib.sha256(content).hexdigest()
    job = FileJob(id=str(uuid4()), owner_id=owner, kind=kind, filename=filename[:180], digest=digest)
    if os.getenv("FILE_STORAGE_BUCKET"):
        job.object_key = f"{owner}/{job.id}"
        url, headers = storage_url(job.object_key)
        response = httpx.post(url, content=content, headers={**headers, "Content-Type": "application/octet-stream"}, timeout=30)
        response.raise_for_status()
    else:
        # Local development needs no external credentials. Bytes remain transactional.
        job.data = content
    db.add(job)
    db.flush()
    return job


def load_file(job):
    if job.expires_at < now():
        raise HTTPException(410, "File sementara kedaluwarsa. Unggah kembali.")
    if job.data is not None:
        return job.data
    if job.object_key:
        url, headers = storage_url(job.object_key)
        response = httpx.get(url, headers=headers, timeout=30)
        response.raise_for_status()
        return response.content
    raise HTTPException(410, "File sementara sudah dihapus.")


def purge_file(job):
    # Called after ledger changes are committed. An interrupted cleanup is retried.
    if job.object_key:
        url, headers = storage_url(job.object_key)
        response = httpx.delete(url, headers=headers, timeout=20)
        if response.status_code != 404:
            response.raise_for_status()
    job.object_key = None
    job.data = None


def get_job(db, owner, job_id, lock=False):
    stmt = select(FileJob).where(FileJob.id == job_id, FileJob.owner_id == owner)
    job = db.scalar(stmt.with_for_update() if lock else stmt)
    if not job:
        raise HTTPException(404, "Pekerjaan tidak ditemukan.")
    return job
