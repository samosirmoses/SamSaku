"""Persistent file storage and retrieval for import workbooks and receipt jobs."""
import hashlib
import os
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

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


def load_file(job: FileJob) -> bytes:
    if job.expires_at < now():
        raise HTTPException(410, "File sementara kedaluwarsa. Unggah kembali.")
    if job.data is not None:
        return job.data
    if job.object_key:
        url, headers = storage_url(job.object_key)
        response = get_http_client().get(url, headers=headers, timeout=30)
        response.raise_for_status()
        return response.content
    raise HTTPException(410, "File sementara sudah dihapus.")


def purge_file(job: FileJob) -> None:
    if job.object_key:
        url, headers = storage_url(job.object_key)
        response = get_http_client().delete(url, headers=headers, timeout=20)
        if response.status_code != 404:
            response.raise_for_status()
    job.object_key = None
    job.data = None


def get_job(db: Session, owner: str, job_id: str, lock: bool = False) -> FileJob:
    stmt = select(FileJob).where(FileJob.id == job_id, FileJob.owner_id == owner)
    job = db.scalar(stmt.with_for_update() if lock else stmt)
    if not job:
        raise HTTPException(404, "Pekerjaan tidak ditemukan.")
    return job


__all__ = ["FileJob", "ImportEntry", "get_job", "load_file", "now", "purge_file", "storage_url", "store_file"]
