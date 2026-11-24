"""Workbook import, private receipt OCR, and consistent report downloads."""
from datetime import date
from typing import Literal

import httpx
from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, Response, UploadFile
from fastapi.routing import APIRoute
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import imports, ledger
from .auth import configured_owner, owner, secret_matches
from .db import get_db, lock_owner
from .jobs import FileJob, get_job, load_file, now, purge_file, store_file
from .models import Evidence, Transaction
from .ocr import create_receipt, process_receipt, scan_receipt_auto
from .reports import csv_bytes, report_csv, report_pdf
from .schemas import TransactionIn
from .xlsx import WorkbookError

class WorkbookRoute(APIRoute):
    def get_route_handler(self):
        handle = super().get_route_handler()
        async def validate_file(request):
            try:
                return await handle(request)
            except WorkbookError as err:
                raise HTTPException(422, str(err)) from err
        return validate_file


router = APIRouter(prefix="/v1", route_class=WorkbookRoute)
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
Kind = Literal["transactions", "masters"]
UPLOAD_LIMIT = 6 * 1024 * 1024


class SheetMap(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    entity: Literal["transactions","accounts","categories","merchants","aliases","schemes","pots"]
    header_row: int = Field(1, ge=1, le=200)
    mapping: dict[str, str] = Field(default_factory=dict, max_length=50)
    date_order: Literal["DMY","MDY","YMD"] = "DMY"
    categories: dict[str,str] = Field(default_factory=dict, max_length=1000)
    default_account: str | None = None


class Preview(BaseModel):
    sheets: list[SheetMap] = Field(min_length=1, max_length=40)
    mapping_name: str | None = Field(None, max_length=80)


class RowKey(BaseModel):
    sheet: str
    row: int


class Commit(BaseModel):
    revision: str
    exclude: list[RowKey] = Field(default_factory=list, max_length=10000)
    accept_similar: list[RowKey] = Field(default_factory=list, max_length=10000)


class ConfirmReceipt(BaseModel):
    transaction_id: str | None = None
    transaction: TransactionIn | None = None


def attachment(content, filename, mime):
    return Response(content, media_type=mime, headers={"Content-Disposition": f'attachment; filename="{filename}"', "Cache-Control":"private, no-store"})


def read_upload(file):
    content = file.file.read(UPLOAD_LIMIT + 1)
    if not content or len(content) > UPLOAD_LIMIT:
        raise HTTPException(422, "Ukuran file harus antara 1 byte dan 6 MB.")
    return content


def cleanup(db, job):
    try:
        purge_file(job)
        db.commit()
    except (httpx.HTTPError, RuntimeError):
        db.rollback()  # Retry on the next cleanup request.


@router.get("/imports/template")
def download_template(kind: Kind, _=Depends(owner)):
    return attachment(imports.template(kind), f"SamSaku_{kind}.xlsx", XLSX)


@router.post("/imports/upload")
def upload(file: UploadFile = File(), kind: Kind = Form(), user=Depends(owner), db: Session=Depends(get_db)):
    name = file.filename or ""
    if not name.casefold().endswith(".xlsx"):
        raise HTTPException(422, "Unggah workbook .xlsx.")
    data = read_upload(file)
    sheets = imports.inspect(data)
    job = store_file(db, user, kind, name, data)
    db.commit()
    return {"id":job.id, "kind":kind, "sheets":sheets}


def import_job(db, user, job_id, lock=False):
    job = get_job(db, user, job_id, lock=lock)
    if job.kind not in ("transactions","masters"):
        raise HTTPException(404, "Impor tidak ditemukan.")
    return job


@router.get("/imports")
def history(user=Depends(owner), db: Session=Depends(get_db)):
    query = select(FileJob.id, FileJob.filename, FileJob.kind, FileJob.status, FileJob.created_at).where(
        FileJob.owner_id == user, FileJob.kind.in_(["transactions","masters"])).order_by(FileJob.created_at.desc()).limit(100)
    return [dict(row) for row in db.execute(query).mappings()]


@router.get("/imports/mappings")
def mappings(user=Depends(owner), db: Session=Depends(get_db)):
    history = db.execute(select(FileJob.config).where(FileJob.owner_id==user, FileJob.config.is_not(None))
        .order_by(FileJob.created_at.desc()).limit(200))
    seen = {}
    for (config,) in history:
        if config.get("mapping_name"):
            seen.setdefault(config["mapping_name"], {"mapping_name":config["mapping_name"],"sheets":config["sheets"]})
    return list(seen.values())


@router.post("/imports/{job_id}/preview")
def preview(job_id: str, body: Preview, user=Depends(owner), db: Session=Depends(get_db)):
    lock_owner(db, user)
    job = import_job(db, user, job_id, True)
    if job.status in ("done", "approved"):
        raise HTTPException(409, "Batch ini sudah disetujui.")
    plans = [s.model_dump() for s in body.sheets]
    if len({p["name"] for p in plans}) != len(plans):
        raise HTTPException(422, "Setiap sheet hanya boleh dipilih sekali.")
    if any((p["entity"] == "transactions") != (job.kind == "transactions") for p in plans):
        raise HTTPException(422, "Jenis sheet harus sesuai dengan jenis impor.")
    result = imports.evaluate(db, user, job, plans)
    job.config = body.model_dump()
    job.result = result
    job.status = "preview"
    db.commit()
    return result


@router.post("/imports/{job_id}/commit")
def commit(job_id: str, body: Commit, user=Depends(owner), db: Session=Depends(get_db)):
    lock_owner(db, user)
    job = import_job(db, user, job_id, True)
    if job.status == "done":
        return job.result
    if job.status == "approved":
        return publish_approved(db, user, job_id)
    if job.status != "preview" or job.result.get("revision") != body.revision:
        raise HTTPException(409, "Buat pratinjau terbaru sebelum menyimpan.")
    excluded = {(r.sheet,r.row) for r in body.exclude}
    accepted = {(r.sheet,r.row) for r in body.accept_similar}
    for row in job.result["rows"]:
        key = (row["sheet"],row["row"])
        if key not in excluded and (row["status"]=="error" or (row["status"]=="similar" and key not in accepted)):
            raise HTTPException(409, "Selesaikan baris yang perlu ditinjau.")
    # Persist the owner's exact decision before starting potentially slow database work.
    job.config = {**job.config, "approval":body.model_dump()}
    job.status = "approved"
    db.commit()
    return publish_approved(db, user, job_id)


def publish_approved(db, user, job_id):
    lock_owner(db, user)
    job = import_job(db, user, job_id, True)
    if job.status == "done":
        return job.result
    if job.status != "approved":
        raise HTTPException(409, "Impor memerlukan persetujuan.")
    approval = Commit.model_validate(job.config["approval"])
    plans = job.config["sheets"]
    try:
        if imports.evaluate(db, user, job, plans)["revision"] != approval.revision:
            raise HTTPException(409, "Data berubah sejak ditinjau. Segarkan pratinjau.")
        result = imports.evaluate(db, user, job, plans, apply=True,
            excluded={(r.sheet,r.row) for r in approval.exclude}, accepted={(r.sheet,r.row) for r in approval.accept_similar})
    except (HTTPException, WorkbookError):
        job.status = "preview"
        job.config = {k:v for k,v in job.config.items() if k != "approval"}
        db.commit()
        raise
    counts = result["counts"]
    final = {"status":"done", "id":job.id, "counts":counts,
             "applied":sum(counts.get(k,0) for k in ("new","similar","update")),
             "skipped":counts.get("duplicate",0) + counts.get("excluded",0)}
    job.result = final
    job.status = "done"
    db.commit()
    cleanup(db, job)
    return final


@router.get("/imports/{job_id}/errors")
def errors(job_id: str, user=Depends(owner), db: Session=Depends(get_db)):
    job = import_job(db, user, job_id)
    rows = [["Sheet","Baris","Status","Alasan"]]
    rows.extend([r["sheet"],r["row"],r["status"],r["message"]] for r in (job.result or {}).get("rows",[]) if r["status"] in ("error","similar"))
    return attachment(csv_bytes(rows), "SamSaku_tinjauan.csv", "text/csv")


@router.get("/imports/{job_id}")
def batch_status(job_id: str, user=Depends(owner), db: Session=Depends(get_db)):
    job = import_job(db, user, job_id)
    return {"id":job.id, "status":job.status, "config":job.config, "result":job.result}


@router.get("/reports/{format}")
def report(format: Literal["csv","pdf"], start: date, end: date, details: bool=True, user=Depends(owner), db: Session=Depends(get_db)):
    report = ledger.summary(db, user, start, end)
    data = report_csv(report) if format == "csv" else report_pdf(report, details)
    return attachment(data, f"SamSaku_{start}_{end}.{format}", "text/csv" if format=="csv" else "application/pdf")


@router.post("/receipts/scan")
def scan_receipt(file: UploadFile = File(), user=Depends(owner), db: Session = Depends(get_db)):
    lock_owner(db, user)
    return scan_receipt_auto(db, user, file.filename or "struk.jpg", read_upload(file))


@router.post("/receipts")
def upload_receipt(file: UploadFile=File(), user=Depends(owner), db: Session=Depends(get_db)):
    job = create_receipt(db, user, file.filename or "struk.jpg", read_upload(file))
    db.commit()
    return {"id":job.id,"status":job.status}


@router.post("/receipts/{job_id}/process")
def recognize(job_id: str, user=Depends(owner), db: Session=Depends(get_db)):
    lock_owner(db, user)
    return process_receipt(db, user, job_id)


@router.post("/receipts/{job_id}/confirm")
def confirm_receipt(job_id: str, body: ConfirmReceipt, user=Depends(owner), db: Session=Depends(get_db)):
    lock_owner(db, user)
    job = get_job(db, user, job_id, lock=True)
    if job.kind != "receipt":
        raise HTTPException(404, "Struk tidak ditemukan.")
    if job.status == "done":
        return job.result
    if job.status != "review" or bool(body.transaction) == bool(body.transaction_id):
        raise HTTPException(422, "Tautkan ke satu transaksi atau isi draf baru.")
    evidence = ledger.owned(db, Evidence, user, job.result["evidence_id"])
    if evidence.transaction_id:
        tx = ledger.owned(db, Transaction, user, evidence.transaction_id)
    elif evidence.status != "review":
        raise HTTPException(409, "Bukti sudah diselesaikan.")
    elif body.transaction:
        tx = ledger.post_transaction(db, user, body.transaction,source="receipt",source_ref=job.id)
    else:
        tx = ledger.owned(db, Transaction, user, body.transaction_id)
    evidence.transaction_id, evidence.status = tx.id, "linked"
    job.result = {**job.result,"transaction_id":tx.id}
    job.status = "done"
    db.commit()
    return job.result


@router.post("/jobs/tick")
def process_pending(x_job_token: str = Header(""), db: Session=Depends(get_db)):
    if not secret_matches(x_job_token, "JOB_RUNNER_TOKEN"):
        raise HTTPException(403, "Pemicu tidak diizinkan.")
    user = configured_owner()
    lock_owner(db, user)
    # Only explicitly approved batch work is resumed. Unapproved previews remain untouched.
    old = db.scalar(select(FileJob).where(FileJob.owner_id==user, (FileJob.data.is_not(None) | FileJob.object_key.is_not(None)),
        ((FileJob.expires_at <= now()) | FileJob.status.in_(["done","review"]))).order_by(FileJob.created_at).limit(1).with_for_update())
    if old:
        if old.expires_at <= now() and old.status in ("preview","uploaded","approved"):
            old.status, old.result = "expired", None
        cleanup(db, old)
    pending = db.scalar(select(FileJob.id).where(FileJob.owner_id==user,FileJob.status=="approved",
        FileJob.expires_at>now()).order_by(FileJob.created_at).limit(1))
    if pending:
        return publish_approved(db, user, pending)
    job = db.scalar(select(FileJob).where(FileJob.owner_id==user,FileJob.kind=="receipt",FileJob.status=="uploaded",
        FileJob.expires_at>now()).order_by(FileJob.created_at).limit(1))
    if job:
        result = process_receipt(db, user, job.id)
        return {"status":result["status"],"id":job.id}
    return {"status":"idle"}
