"""Private OCR. A receipt stays a reviewable draft until its owner confirms."""
from datetime import date, timedelta
from io import BytesIO

from fastapi import HTTPException
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import select

from .receipt_text import extract
from .jobs import get_job, load_file, purge_file, store_file
from .models import Evidence, Transaction


def open_image(data):
    try:
        im = Image.open(BytesIO(data))
        if im.format not in ("PNG", "JPEG", "WEBP") or im.width * im.height > 16_000_000:
            raise ValueError()
        return im
    except (ValueError, OSError, UnidentifiedImageError, Image.DecompressionBombError) as err:
        raise HTTPException(422, "Gunakan gambar JPEG, PNG, atau WebP hingga 16 megapiksel.") from err


def create_receipt(db, owner_id, filename, content):
    with open_image(content) as im:
        im.verify()
    return store_file(db, owner_id, "receipt", filename, content)




def process_receipt(db, owner_id, job_id):
    import pytesseract
    job = get_job(db, owner_id, job_id, lock=True)
    if job.kind != "receipt":
        raise HTTPException(404, "Struk tidak ditemukan.")
    if job.status in ("review", "done"):
        return {"id":job.id,"status":job.status, **job.result}
    with open_image(load_file(job)) as im:
        im.draft("L", (1800, 2400))
        im.thumbnail((1800, 2400))
        grayscale = ImageOps.autocontrast(ImageOps.grayscale(ImageOps.exif_transpose(im)))
        try:
            text = pytesseract.image_to_string(grayscale, lang="ind+eng", config="--psm 6", timeout=25)
        except (RuntimeError, OSError) as err:
            raise HTTPException(503, "OCR belum tersedia. Struk tetap tersimpan untuk dicoba kembali.") from err
    result = extract(text)
    result["candidates"] = []
    if result["amount"] and result["date"]:
        day = date.fromisoformat(result["date"])
        matches = db.scalars(select(Transaction).where(Transaction.owner_id == owner_id, Transaction.kind == "expense",
            Transaction.amount == result["amount"], Transaction.date.between(day-timedelta(days=1), day+timedelta(days=1))).limit(10))
        result["candidates"] = [{"id":x.id,"date":x.date.isoformat(),"description":x.description,"amount":x.amount} for x in matches]
    evidence = Evidence(owner_id=owner_id,source="receipt",external_id=job.id,digest=job.digest,
        text=result["merchant"] or "Foto struk",status="review",parsed=result.copy())
    db.add(evidence)
    db.flush()
    result["evidence_id"] = evidence.id
    job.result, job.status = result, "review"
    db.commit()
    # OCR output is confirmed later; the complete photograph is now unnecessary.
    try:
        purge_file(job)
        db.commit()
    except Exception:
        db.rollback()  # periodic cleanup handles interrupted deletion
    return {"id":job.id,"status":job.status, **result}
