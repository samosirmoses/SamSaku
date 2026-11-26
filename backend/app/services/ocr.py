"""Lightweight receipt scanner powered exclusively by Gemini Vision AI (no local Tesseract)."""
import base64
import json
import logging
import re
from datetime import date, datetime, timedelta
from io import BytesIO

from fastapi import HTTPException
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..core.config import JAKARTA, gemini_api_key, gemini_model, is_test_env
from ..core.http_client import get_http_client
from ..models import Account, Category, Evidence, Transaction
from .jobs import get_job, load_file, purge_file, store_file
from .receipt_text import extract, infer_category

logger = logging.getLogger("samsaku.ocr")


def open_image(data: bytes):
    try:
        im = Image.open(BytesIO(data))
        if im.format not in ("PNG", "JPEG", "WEBP") or im.width * im.height > 16_000_000:
            raise ValueError()
        return im
    except (ValueError, OSError, UnidentifiedImageError, Image.DecompressionBombError) as err:
        raise HTTPException(422, "Gunakan gambar JPEG, PNG, atau WebP hingga 16 megapiksel.") from err


def create_receipt(db: Session, owner_id: str, filename: str, content: bytes):
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
        s = val.strip()
        s = re.sub(r"[.,]\d{2}$", "", s)
        digits = re.sub(r"[^\d]", "", s)
        if digits:
            n = int(digits)
            return n if 100 <= n <= 1_000_000_000 else None
    return None


def _scan_with_gemini(
    content: bytes,
    category_names: list[str],
    account_names: list[str] | None = None,
) -> dict | None:
    api_key = gemini_api_key()
    if not api_key or is_test_env():
        return None

    model = gemini_model()
    try:
        jpeg_bytes = _prepare_jpeg_for_vision(content)
        b64_img = base64.b64encode(jpeg_bytes).decode("ascii")
        cats_text = ", ".join(category_names) if category_names else "Makan & Minum, Belanja, Transportasi, Lainnya"
        accs_text = ", ".join(account_names) if account_names else "BCA, Tunai"
        prompt = (
            "Kamu adalah asisten pencatat keuangan pribadi Indonesia. Analisis gambar struk belanja, struk EDC, "
            "atau screenshot bukti transaksi/QRIS/transfer bank (myBCA, m-BCA, GoPay, OVO, DANA, ShopeePay, dll.) ini.\n"
            "Kembalikan HANYA JSON valid dengan skema:\n"
            '{"merchant": string|null, "items": string[], "amount": integer|null, "date": "YYYY-MM-DD"|null, '
            '"category": string|null, "account": string|null}\n'
            "Aturan ketat:\n"
            "1. merchant: nama toko/restoran/merchant/penerima transfer yang singkat & bersih. "
            "Untuk screenshot myBCA/m-BCA/QRIS, ambil nama Merchant atau Penerima/Tujuan (JANGAN isi 'BCA', 'myBCA', 'Berhasil', atau 'Transaksi Berhasil').\n"
            "2. items: maksimal 4 nama barang/menu/berita transfer singkat (tanpa kode/SKU/harga). Kosongkan [] jika tidak ada rincian item.\n"
            "3. amount: TOTAL AKHIR YANG DIBAYAR dalam Rupiah bulat sebagai integer murni (tanpa Rp, tanpa titik/koma, TANPA sen). "
            "PENTING: pada format myBCA/bank seperti 'IDR 32,000.00' atau 'Rp 150.000,00', abaikan '.00' / ',00' sehingga menjadi 32000 atau 150000! "
            "Pada struk kasir, ambil GRAND TOTAL / TOTAL BAYAR / NETTO / QRIS / EDC / DEBIT (JANGAN ambil uang Tunai/Cash diterima atau Kembalian/Change).\n"
            "4. date: tanggal transaksi pada struk/bukti dalam format YYYY-MM-DD (atau null jika tidak terbaca).\n"
            f"5. category: pilih SATU nama kategori paling cocok PERSIS dari daftar ini: [{cats_text}].\n"
            f"6. account: jika sumber pembayaran/bank/e-wallet terlihat di gambar dan cocok dengan salah satu dompet di daftar [{accs_text}], pilih nama dompet itu PERSIS; jika tidak yakin, isi null.\n"
            "Jika gambar tidak terbaca, isi field yang tidak pasti dengan null."
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
        res = get_http_client().post(url, params={"key": api_key}, json=payload, timeout=25.0)
        if res.status_code != 200:
            logger.warning("Gemini Vision API returned %s: %s", res.status_code, res.text[:250])
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
        acc_hint = str(data.get("account") or "").strip() or None
        if not merchant and not amount and not items:
            return None

        return {
            "merchant": merchant,
            "items": items,
            "amount": amount,
            "amount_options": [amount] if amount else [],
            "date": tx_date,
            "category_hint": cat_hint,
            "account_hint": acc_hint,
            "engine": "gemini",
            "raw_text": f"{merchant or ''} {' '.join(items)}".strip(),
        }
    except Exception as exc:
        logger.warning("Gemini Vision receipt scan failed: %s", exc)
        return None


def _format_description(merchant: str | None, items: list[str], fallback: str = "") -> str:
    base = (merchant or "").strip()
    clean_items = [x.strip() for x in items if x and x.strip()][:4]
    if base and clean_items:
        return f"{base} — {', '.join(clean_items)}"[:180]
    if base:
        return base[:180]
    if clean_items:
        return ", ".join(clean_items)[:180]
    return fallback[:180]


def _enrich_category(db: Session, owner_id: str, parsed: dict, raw_text: str, cats: list[dict]) -> dict:
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


def _analyze_receipt(db: Session, owner_id: str, content: bytes) -> tuple[dict, str]:
    all_cats = [
        {"id": c.id, "name": c.name, "kind": c.kind, "archived": c.archived}
        for c in db.scalars(select(Category).where(Category.owner_id == owner_id)).all()
    ]
    expense_cat_names = [c["name"] for c in all_cats if c["kind"] == "expense" and not c["archived"]]
    accounts = list(db.scalars(select(Account).where(Account.owner_id == owner_id)).all())
    account_names = [a.name for a in accounts]

    ai_res = _scan_with_gemini(content, expense_cat_names, account_names)
    if not ai_res:
        if not gemini_api_key():
            raise HTTPException(
                503,
                "Scan struk memerlukan GEMINI_API_KEY pada konfigurasi server (OCR lokal dinonaktifkan agar hemat RAM).",
            )
        raise HTTPException(
            503,
            "Gemini Vision belum berhasil membaca struk ini. Coba foto ulang yang lebih jelas atau isi manual.",
        )

    enriched = _enrich_category(db, owner_id, ai_res, ai_res.get("raw_text", ""), all_cats)
    acc_hint = (ai_res.get("account_hint") or "").strip().lower()
    if acc_hint:
        matched_acc = next(
            (a for a in accounts if a.name.strip().lower() == acc_hint or a.code.strip().lower() == acc_hint), None
        )
        if not matched_acc:
            matched_acc = next(
                (a for a in accounts if acc_hint in a.name.strip().lower() or a.name.strip().lower() in acc_hint),
                None,
            )
        if matched_acc:
            enriched["account_id"] = matched_acc.id
            enriched["account_name"] = matched_acc.name
    return enriched, ai_res.get("raw_text", "")


def scan_receipt_auto(db: Session, owner_id: str, filename: str, content: bytes) -> dict:
    """Directly scan a receipt image with Gemini Vision to auto-fill transaction fields."""
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
        "account_id": enriched.get("account_id"),
        "account_name": enriched.get("account_name"),
        "engine": enriched.get("engine", "gemini"),
        "text": text.strip()[:1000],
    }


def process_receipt(db: Session, owner_id: str, job_id: str) -> dict:
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


__all__ = [
    "_format_description",
    "_parse_iso_date",
    "_parse_positive_int",
    "_scan_with_gemini",
    "create_receipt",
    "extract",
    "open_image",
    "process_receipt",
    "scan_receipt_auto",
]
