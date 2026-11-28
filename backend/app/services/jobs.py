"""Persistent file storage and retrieval for import workbooks and receipt jobs."""
import hashlib
import os
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..core.db import lock_owner
from ..core.http_client import get_http_client
from ..models import FileJob, ImportEntry, job_now

now = job_now


def storage_url(key: str) -> tuple[str, dict[str, str]]:
    url = os.getenv("SUPABASE_URL", "").rstrip("/")
    bucket = os.getenv("FILE_STORAGE_BUCKET", "")
    secret = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    if not (url and bucket and secret):
        raise RuntimeError("Konfigurasi penyimpanan privat belum lengkap.")
    return f"{url}/storage/v1/object/{bucket}/{key}", {"Authorization": f"Bearer {secret}", "apikey": secret}


def store_file(db: Session, owner: str, kind: str, filename: str, content: bytes) -> FileJob:
    digest = hashlib.sha256(content).hexdigest()
    job = FileJob(id=str(uuid4()), owner_id=owner, kind=kind, filename=filename[:180], digest=digest)
    if os.getenv("FILE_STORAGE_BUCKET"):
        job.object_key = f"{owner}/{job.id}"
        url, headers = storage_url(job.object_key)
        response = get_http_client().post(
            url, content=content, headers={**headers, "Content-Type": "application/octet-stream"}, timeout=30
        )
        response.raise_for_status()
    else:
        job.data = content
    db.add(job)
    db.flush()
    return job


def load_remote_file(object_key: str) -> bytes:
    url, headers = storage_url(object_key)
    response = get_http_client().get(url, headers=headers, timeout=30)
    response.raise_for_status()
    return response.content


def load_file(job: FileJob) -> bytes:
    if job.expires_at < now():
        raise HTTPException(410, "File sementara kedaluwarsa. Unggah kembali.")
    if job.data is not None:
        return job.data
    if job.object_key:
        return load_remote_file(job.object_key)
    raise HTTPException(410, "File sementara sudah dihapus.")


def purge_remote_file(object_key: str) -> None:
    url, headers = storage_url(object_key)
    response = get_http_client().delete(url, headers=headers, timeout=20)
    if response.status_code != 404:
        response.raise_for_status()


def purge_file(job: FileJob) -> None:
    if job.object_key:
        purge_remote_file(job.object_key)
    job.object_key = None
    job.data = None


def get_job(db: Session, owner: str, job_id: str, lock: bool = False) -> FileJob:
    stmt = select(FileJob).where(FileJob.id == job_id, FileJob.owner_id == owner)
    job = db.scalar(stmt.with_for_update() if lock else stmt)
    if not job:
        raise HTTPException(404, "Pekerjaan tidak ditemukan.")
    return job


def tick_pending_jobs(db: Session, owner_id: str) -> dict:
    from .imports import publish_approved
    from .ocr import process_receipt
    from .telegram import is_daily_recap_enabled, maybe_send_daily_recap

    lock_owner(db, owner_id)
    old = db.scalar(
        select(FileJob)
        .where(
            FileJob.owner_id == owner_id,
            (FileJob.data.is_not(None) | FileJob.object_key.is_not(None)),
            ((FileJob.expires_at <= now()) | FileJob.status.in_(["done", "review"])),
        )
        .order_by(FileJob.created_at)
        .limit(1)
        .with_for_update()
    )
    purge_key = None
    old_id = None
    if old:
        if old.expires_at <= now() and old.status in ("preview", "uploaded", "approved"):
            old.status, old.result = "expired", None
        old.data = None
        purge_key = old.object_key
        old_id = old.id
    db.commit()
    if purge_key and old_id:
        try:
            purge_remote_file(purge_key)
            lock_owner(db, owner_id)
            purged = db.get(FileJob, old_id)
            if purged and purged.owner_id == owner_id:
                purged.object_key = None
            db.commit()
        except Exception:
            db.rollback()
    pending = db.scalar(
        select(FileJob.id)
        .where(FileJob.owner_id == owner_id, FileJob.status == "approved", FileJob.expires_at > now())
        .order_by(FileJob.created_at)
        .limit(1)
    )
    if pending:
        db.rollback()
        return publish_approved(db, owner_id, pending)
    job_id = db.scalar(
        select(FileJob.id)
        .where(
            FileJob.owner_id == owner_id,
            FileJob.kind == "receipt",
            FileJob.status == "uploaded",
            FileJob.expires_at > now(),
        )
        .order_by(FileJob.created_at)
        .limit(1)
    )
    db.rollback()
    if job_id:
        result = process_receipt(db, owner_id, job_id)
        return {"status": result["status"], "id": job_id}
    if is_daily_recap_enabled():
        try:
            recap = maybe_send_daily_recap(db, owner_id)
            if recap.get("sent"):
                return {"status": "recap_sent", "date": recap["date"]}
        except Exception:
            db.rollback()
    return {"status": "idle"}


__all__ = [
    "FileJob",
    "ImportEntry",
    "get_job",
    "load_file",
    "load_remote_file",
    "now",
    "purge_file",
    "purge_remote_file",
    "storage_url",
    "store_file",
    "tick_pending_jobs",
]
