"""Private OCR and instant auto-fill scanner for receipts."""
from datetime import date, datetime, timedelta
from io import BytesIO
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import select

from .receipt_text import extract, infer_category
from .jobs import get_job, load_file, purge_file, store_file
from .models import Category, Evidence, Transaction

JAKARTA = ZoneInfo("Asia/Jakarta")


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


def _ocr_image_bytes(content: bytes) -> str:
    import pytesseract
    with open_image(content) as im:
        im.draft("L", (1800, 2400))
        im.thumbnail((1800, 2400))
        grayscale = ImageOps.autocontrast(ImageOps.grayscale(ImageOps.exif_transpose(im)))
        for lang in ("ind+eng", "eng"):
            try:
                return pytesseract.image_to_string(grayscale, lang=lang, config="--psm 6", timeout=25)
            except (RuntimeError, OSError):
                continue
        raise HTTPException(503, "OCR belum tersedia pada server ini.")


def _enrich_category(db, owner_id: str, parsed: dict, raw_text: str) -> dict:
    cats = [
        {"id": c.id, "name": c.name, "kind": c.kind, "archived": c.archived}
        for c in db.scalars(select(Category).where(Category.owner_id == owner_id)).all()
    ]
    recent_tx = [
        {"description": t.description, "category_id": t.category_id}
        for t in db.scalars(
            select(Transaction)
            .where(Transaction.owner_id == owner_id, Transaction.kind == "expense", Transaction.category_id.is_not(None))
            .order_by(Transaction.date.desc(), Transaction.created_at.desc())
            .limit(100)
        ).all()
    ]
    cat_id, cat_name = infer_category(cats, recent_tx, raw_text, parsed.get("merchant"))
    return {
        **parsed,
        "category_id": cat_id,
        "category_name": cat_name,
        "date": parsed.get("date") or datetime.now(JAKARTA).date().isoformat(),
        "amount": parsed.get("amount") or (parsed["amount_options"][-1] if parsed.get("amount_options") else None),
    }


def scan_receipt_auto(db, owner_id: str, filename: str, content: bytes) -> dict:
    """Directly scan a receipt image to auto-fill transaction form fields without creating a review attachment."""
    with open_image(content) as im:
        im.verify()
    text = _ocr_image_bytes(content)
    parsed = extract(text)
    enriched = _enrich_category(db, owner_id, parsed, text)
    return {
        "merchant": enriched.get("merchant") or filename.rsplit(".", 1)[0].replace("_", " ").replace("-", " ").strip() or "Belanja",
        "amount": enriched.get("amount"),
        "amount_options": enriched.get("amount_options", []),
        "date": enriched.get("date"),
        "category_id": enriched.get("category_id"),
        "category_name": enriched.get("category_name"),
        "text": text.strip()[:1000],
    }


def process_receipt(db, owner_id, job_id):
    job = get_job(db, owner_id, job_id, lock=True)
    if job.kind != "receipt":
        raise HTTPException(404, "Struk tidak ditemukan.")
    if job.status in ("review", "done"):
        return {"id": job.id, "status": job.status, **job.result}
    text = _ocr_image_bytes(load_file(job))
    result = _enrich_category(db, owner_id, extract(text), text)
    result["candidates"] = []
    if result["amount"] and result["date"]:
        day = date.fromisoformat(result["date"])
        matches = db.scalars(
            select(Transaction)
            .where(
                Transaction.owner_id == owner_id,
                Transaction.kind == "expense",
                Transaction.amount == result["amount"],
                Transaction.date.between(day - timedelta(days=1), day + timedelta(days=1)),
            )
            .limit(10)
        )
        result["candidates"] = [
            {"id": x.id, "date": x.date.isoformat(), "description": x.description, "amount": x.amount}
            for x in matches
        ]
    evidence = Evidence(
        owner_id=owner_id,
        source="receipt",
        external_id=job.id,
        digest=job.digest,
        text=result["merchant"] or "Foto struk",
        status="review",
        parsed=result.copy(),
    )
    db.add(evidence)
    db.flush()
    result["evidence_id"] = evidence.id
    job.result, job.status = result, "review"
    db.commit()
    try:
        purge_file(job)
        db.commit()
    except Exception:
        db.rollback()
    return {"id": job.id, "status": job.status, **result}
