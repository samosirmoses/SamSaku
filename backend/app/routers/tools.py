"""Workbook import, Gemini receipt scanning, report downloads, and pending job tick routes."""
from datetime import date
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, Response, UploadFile
from fastapi.routing import APIRoute
from sqlalchemy.orm import Session

from ..core.auth import configured_owner, owner, secret_matches
from ..core.db import get_db
from ..core.realtime import notify as realtime_notify
from ..schemas import Commit, ConfirmReceipt, Preview
from ..services import imports
from ..services.jobs import store_file, tick_pending_jobs
from ..services.ocr import confirm_receipt_job, create_receipt, process_receipt, scan_receipt_auto
from ..services.reports import csv_bytes, report_csv, report_pdf
from ..services.summary import summary as build_summary
from ..services.xlsx import WorkbookError


class WorkbookRoute(APIRoute):
    def get_route_handler(self):
        handle = super().get_route_handler()

        async def validate_file(request):
            try:
                return await handle(request)
            except WorkbookError as err:
                raise HTTPException(422, str(err)) from err

        return validate_file


router = APIRouter(prefix="/v1", route_class=WorkbookRoute, tags=["tools"])
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
Kind = Literal["transactions", "masters"]
UPLOAD_LIMIT = 6 * 1024 * 1024


def attachment(content: bytes, filename: str, mime: str) -> Response:
    return Response(
        content,
        media_type=mime,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "private, no-store",
        },
    )


def read_upload(file: UploadFile) -> bytes:
    content = file.file.read(UPLOAD_LIMIT + 1)
    if not content or len(content) > UPLOAD_LIMIT:
        raise HTTPException(422, "Ukuran file harus antara 1 byte dan 6 MB.")
    return content


@router.get("/imports/template")
def download_template(kind: Kind, _=Depends(owner)):
    return attachment(imports.template(kind), f"SamSaku_{kind}.xlsx", XLSX)


@router.post("/imports/upload")
def upload(file: UploadFile = File(), kind: Kind = Form(), user=Depends(owner), db: Session = Depends(get_db)):
    name = file.filename or ""
    if not name.casefold().endswith(".xlsx"):
        raise HTTPException(422, "Unggah workbook .xlsx.")
    data = read_upload(file)
    sheets = imports.inspect(data)
    job = store_file(db, user, kind, name, data)
    db.commit()
    return {"id": job.id, "kind": kind, "sheets": sheets}


@router.get("/imports")
def history(user=Depends(owner), db: Session = Depends(get_db)):
    return imports.list_import_history(db, user)


@router.get("/imports/mappings")
def mappings(user=Depends(owner), db: Session = Depends(get_db)):
    return imports.list_import_mappings(db, user)


@router.post("/imports/{job_id}/preview")
def preview(job_id: str, body: Preview, user=Depends(owner), db: Session = Depends(get_db)):
    return imports.preview_import(db, user, job_id, body)


@router.post("/imports/{job_id}/commit")
def commit(job_id: str, body: Commit, user=Depends(owner), db: Session = Depends(get_db)):
    result, changed = imports.commit_import(db, user, job_id, body)
    if changed:
        realtime_notify(user, "import:done", "Impor Excel selesai.")
    return result


@router.get("/imports/{job_id}/errors")
def errors(job_id: str, user=Depends(owner), db: Session = Depends(get_db)):
    return attachment(csv_bytes(imports.import_errors_rows(db, user, job_id)), "SamSaku_tinjauan.csv", "text/csv")


@router.get("/imports/{job_id}")
def batch_status(job_id: str, user=Depends(owner), db: Session = Depends(get_db)):
    return imports.get_import_status(db, user, job_id)


@router.get("/reports/{format}")
def report(
    format: Literal["csv", "pdf"],
    start: date,
    end: date,
    details: bool = True,
    user=Depends(owner),
    db: Session = Depends(get_db),
):
    report_data = build_summary(db, user, start, end)
    data = report_csv(report_data) if format == "csv" else report_pdf(report_data, details)
    return attachment(
        data,
        f"SamSaku_{start}_{end}.{format}",
        "text/csv" if format == "csv" else "application/pdf",
    )


@router.post("/receipts/scan")
def scan_receipt(file: UploadFile = File(), user=Depends(owner), db: Session = Depends(get_db)):
    return scan_receipt_auto(db, user, file.filename or "struk.jpg", read_upload(file))


@router.post("/receipts")
def upload_receipt(file: UploadFile = File(), user=Depends(owner), db: Session = Depends(get_db)):
    job = create_receipt(db, user, file.filename or "struk.jpg", read_upload(file))
    db.commit()
    return {"id": job.id, "status": job.status}


@router.post("/receipts/{job_id}/process")
def recognize(job_id: str, user=Depends(owner), db: Session = Depends(get_db)):
    return process_receipt(db, user, job_id)


@router.post("/receipts/{job_id}/confirm")
def confirm_receipt(job_id: str, body: ConfirmReceipt, user=Depends(owner), db: Session = Depends(get_db)):
    result, changed = confirm_receipt_job(db, user, job_id, body)
    if changed:
        realtime_notify(user, "receipt:confirm")
    return result


@router.post("/jobs/tick")
def process_pending(x_job_token: str = Header(""), db: Session = Depends(get_db)):
    if not secret_matches(x_job_token, "JOB_RUNNER_TOKEN"):
        raise HTTPException(403, "Pemicu tidak diizinkan.")
    return tick_pending_jobs(db, configured_owner())
