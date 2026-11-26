"""Receipt scanner with Gemini Vision AI primary engine and enhanced local Tesseract fallback."""
import base64
import json
import logging
import os
import re
from datetime import date, datetime, timedelta
from io import BytesIO
from zoneinfo import ZoneInfo

import httpx
from fastapi import HTTPException
from PIL import Image, ImageFilter, ImageOps, UnidentifiedImageError
from sqlalchemy import select

from .jobs import get_job, load_file, purge_file, store_file
from .models import Category, Evidence, Transaction
from .receipt_text import extract, infer_category

JAKARTA = ZoneInfo("Asia/Jakarta")
logger = logging.getLogger("samsaku.ocr")


def open_image(data: bytes):
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


def _prepare_jpeg_for_vision(content: bytes) -> bytes:
    with open_image(content) as im:
        im = ImageOps.exif_transpose(im)
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        im.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
        buf = BytesIO()
        im.save(buf, format="JPEG", quality=85, optimize=True)
        return buf.getvalue()


def _parse_iso_date(val) -> str | None:
    if not isinstance(val, str):
        return None
    val = val.strip()
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", val):
        return None
    try:
        parsed = date.fromisoformat(val)
        if 2000 <= parsed.year <= 2100:
            return parsed.isoformat()
    except ValueError:
        pass
    return None


def _parse_positive_int(val) -> int | None:
    if isinstance(val, bool) or val is None:
        return None
    if isinstance(val, (int, float)):
        n = int(round(val))
        return n if 100 <= n <= 1_000_000_000 else None
    if isinstance(val, str):
        digits = re.sub(r"[^\d]", "", val.split(",")[0] if re.search(r",\d{2}$", val.strip()) else val)
        if digits:
            n = int(digits)
            return n if 100 <= n <= 1_000_000_000 else None
    return None


def _scan_with_gemini(content: bytes, category_names: list[str]) -> dict | None:
    api_key = (os.getenv("GEMINI_API_KEY") or "").strip()
    if not api_key or os.getenv("SAMSAKU_ENV") == "test":
        return None

    model = (os.getenv("GEMINI_MODEL") or "gemini-2.5-flash").strip()
    try:
        jpeg_bytes = _prepare_jpeg_for_vision(content)
        b64_img = base64.b64encode(jpeg_bytes).decode("ascii")
        cats_text = ", ".join(category_names) if category_names else "Makan & Minum, Belanja, Transportasi, Lainnya"
        prompt = (
            "Baca foto struk belanja Indonesia ini dengan teliti lalu kembalikan HANYA JSON valid dengan skema:\n"
            '{"merchant": string|null, "items": string[], "amount": integer|null, "date": "YYYY-MM-DD"|null, "category": string|null}\n'
            "Aturan ketat:\n"
            "1. merchant: nama toko/restoran/merchant singkat & bersih (tanpa alamat/PT panjang).\n"
            "2. items: maksimal 4 nama barang/menu utama yang dibeli secara ringkas (tanpa kode/SKU/harga).\n"
            "3. amount: TOTAL AKHIR YANG DIBAYAR dalam Rupiah bulat (integer tanpa titik/koma/Rp). "
            "Cari GRAND TOTAL / TOTAL BAYAR / TOTAL / NETTO / QRIS / EDC / DEBIT. "
            "JANGAN ambil uang Tunai/Cash diterima atau Kembalian/Change.\n"
            "4. date: tanggal transaksi pada struk dalam format YYYY-MM-DD (atau null jika tidak ada).\n"
            f"5. category: pilih SATU nama kategori paling sesuai PERSIS dari daftar ini: [{cats_text}].\n"
            "Jika gambar bukan struk atau tidak terbaca, isi field yang tidak pasti dengan null."
        )
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        payload = {
            "contents": [
                {
                    "parts": [
                        {"text": prompt},
                        {"inline_data": {"mime_type": "image/jpeg", "data": b64_img}},
                    ]
                }
            ],
            "generationConfig": {
                "temperature": 0.1,
                "responseMimeType": "application/json",
            },
        }
        with httpx.Client(timeout=22.0) as client:
            res = client.post(url, params={"key": api_key}, json=payload)
            if res.status_code != 200:
                logger.warning("Gemini Vision API returned %s: %s", res.status_code, res.text[:200])
                return None
            body = res.json()
        raw_text = (
            body.get("candidates", [{}])[0]
            .get("content", {})
            .get("parts", [{}])[0]
            .get("text", "")
            .strip()
        )
        if not raw_text:
            return None
        # Strip accidental markdown fences if present
        raw_text = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw_text, flags=re.I | re.S).strip()
        data = json.loads(raw_text)
        if not isinstance(data, dict):
            return None

        merchant = str(data.get("merchant") or "").strip()[:100] or None
        raw_items = data.get("items") if isinstance(data.get("items"), list) else []
        items = [str(it).strip()[:45] for it in raw_items if str(it).strip()][:4]
        amount = _parse_positive_int(data.get("amount"))
        tx_date = _parse_iso_date(data.get("date"))
        cat_hint = str(data.get("category") or "").strip() or None
        if not merchant and not amount and not items:
            return None

        return {
            "merchant": merchant,
            "items": items,
            "amount": amount,
            "amount_options": [amount] if amount else [],
            "date": tx_date,
            "category_hint": cat_hint,
            "engine": "gemini",
            "raw_text": f"{merchant or ''} {' '.join(items)}".strip(),
        }
    except Exception as exc:
        logger.warning("Gemini Vision receipt scan failed, falling back to local OCR: %s", exc)
        return None


def _ocr_image_bytes(content: bytes) -> str:
    import pytesseract

    with open_image(content) as im:
        im = ImageOps.exif_transpose(im)
        # Upscale small thermal receipt captures, cap very large photos
        if im.width < 1200:
            scale = min(2.0, 1200 / max(1, im.width))
            im = im.resize((int(im.width * scale), int(im.height * scale)), Image.Resampling.LANCZOS)
        else:
            im.thumbnail((2000, 2600), Image.Resampling.LANCZOS)

        gray = ImageOps.grayscale(im)
        enhanced = ImageOps.autocontrast(gray.filter(ImageFilter.SHARPEN), cutoff=2)

        best_text = ""
        for variant, cfg in (
            (enhanced, "--oem 3 --psm 6"),
            (enhanced.point(lambda p: 255 if p > 145 else 0), "--oem 3 --psm 4"),
        ):
            for lang in ("ind+eng", "eng"):
                try:
                    txt = pytesseract.image_to_string(variant, lang=lang, config=cfg, timeout=25)
                    if len(txt.strip()) > len(best_text.strip()):
                        best_text = txt
                    if extract(txt).get("amount"):
                        return txt
                    break
                except (RuntimeError, OSError):
                    continue
        if best_text:
            return best_text
        raise HTTPException(503, "OCR belum tersedia pada server ini.")


def _format_description(merchant: str | None, items: list[str], fallback: str = "") -> str:
    base = (merchant or "").strip()
    clean_items = [x.strip() for x in items if x and x.strip()][:4]
    if base and clean_items:
        joined = ", ".join(clean_items)
        return f"{base} — {joined}"[:180]
    if base:
        return base[:180]
    if clean_items:
        return ", ".join(clean_items)[:180]
    return fallback[:180]


def _enrich_category(db, owner_id: str, parsed: dict, raw_text: str) -> dict:
    cats = [
        {"id": c.id, "name": c.name, "kind": c.kind, "archived": c.archived}
        for c in db.scalars(select(Category).where(Category.owner_id == owner_id)).all()
    ]
    cat_id, cat_name = None, None
    hint = (parsed.get("category_hint") or "").strip().lower()
    if hint:
        expense_cats = [c for c in cats if c["kind"] == "expense" and not c["archived"]]
        exact = next((c for c in expense_cats if c["name"].strip().lower() == hint), None)
        if not exact:
            exact = next(
                (c for c in expense_cats if hint in c["name"].strip().lower() or c["name"].strip().lower() in hint),
                None,
            )
        if exact:
            cat_id, cat_name = exact["id"], exact["name"]

    if not cat_id:
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


def _analyze_receipt(db, owner_id: str, content: bytes) -> tuple[dict, str]:
    expense_cat_names = [
        c.name
        for c in db.scalars(
            select(Category).where(
                Category.owner_id == owner_id,
                Category.kind == "expense",
                Category.archived.is_(False),
            )
        ).all()
    ]
    ai_res = _scan_with_gemini(content, expense_cat_names)
    if ai_res:
        enriched = _enrich_category(db, owner_id, ai_res, ai_res.get("raw_text", ""))
        return enriched, ai_res.get("raw_text", "")

    text = _ocr_image_bytes(content)
    parsed = extract(text)
    parsed["engine"] = "tesseract"
    parsed["items"] = []
    enriched = _enrich_category(db, owner_id, parsed, text)
    return enriched, text


def scan_receipt_auto(db, owner_id: str, filename: str, content: bytes) -> dict:
    """Directly scan a receipt image to auto-fill transaction form fields without creating a review attachment."""
    with open_image(content) as im:
        im.verify()
    enriched, text = _analyze_receipt(db, owner_id, content)
    fallback_name = filename.rsplit(".", 1)[0].replace("_", " ").replace("-", " ").strip() or "Belanja"
    items = enriched.get("items") or []
    description = _format_description(enriched.get("merchant"), items, fallback_name)
    return {
        "merchant": description,
        "merchant_name": enriched.get("merchant") or fallback_name,
        "items": items,
        "amount": enriched.get("amount"),
        "amount_options": enriched.get("amount_options", []),
        "date": enriched.get("date"),
        "category_id": enriched.get("category_id"),
        "category_name": enriched.get("category_name"),
        "engine": enriched.get("engine", "tesseract"),
        "text": text.strip()[:1000],
    }


def process_receipt(db, owner_id, job_id):
    job = get_job(db, owner_id, job_id, lock=True)
    if job.kind != "receipt":
        raise HTTPException(404, "Struk tidak ditemukan.")
    if job.status in ("review", "done"):
        return {"id": job.id, "status": job.status, **job.result}
    result, _ = _analyze_receipt(db, owner_id, load_file(job))
    result["merchant"] = _format_description(result.get("merchant"), result.get("items") or [], "Foto struk")
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
