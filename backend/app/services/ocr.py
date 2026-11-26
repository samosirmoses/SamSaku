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
from .receipt_matching import format_receipt_description, resolve_receipt_classification
from .receipt_text import extract, infer_category
from .settings import get_settings

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


def _parse_positive_int(val, allow_zero: bool = False) -> int | None:
    if isinstance(val, bool) or val is None:
        return None
    min_val = 0 if allow_zero else 100
    if isinstance(val, (int, float)):
        n = int(round(val))
        return n if min_val <= n <= 1_000_000_000 else None
    if isinstance(val, str):
        s = val.strip()
        s = re.sub(r"[.,]\d{2}$", "", s)
        digits = re.sub(r"[^\d]", "", s)
        if digits:
            n = int(digits)
            return n if min_val <= n <= 1_000_000_000 else None
    return None


def _clean_str(val, max_len: int = 100) -> str | None:
    if not isinstance(val, str):
        return None
    s = val.strip()[:max_len]
    return s if s and s.lower() not in {"null", "none", "-", "—"} else None


def _scan_with_gemini(
    content: bytes,
    category_names: list[str],
    account_names: list[str] | None = None,
    income_category_names: list[str] | None = None,
    extra_context: str | None = None,
) -> dict | None:
    api_key = gemini_api_key()
    if not api_key or is_test_env():
        return None

    model = gemini_model()
    try:
        jpeg_bytes = _prepare_jpeg_for_vision(content)
        b64_img = base64.b64encode(jpeg_bytes).decode("ascii")
        cats_text = ", ".join(category_names) if category_names else "Makan & Minum, Belanja, Transportasi, Lainnya"
        inc_cats_text = ", ".join(income_category_names) if income_category_names else "Gaji, Bonus & freelance, Lainnya"
        accs_text = ", ".join(account_names) if account_names else "BCA, Tunai"
        context_line = (
            f"\nCatatan tambahan dari pengguna (gunakan sebagai petunjuk berita/kategori bila relevan): {extra_context}\n"
            if extra_context
            else ""
        )
        prompt = (
            "Kamu adalah asisten pencatat keuangan pribadi Indonesia. Analisis gambar struk belanja, struk EDC, "
            "atau screenshot bukti transaksi bank/e-wallet (myBCA, m-BCA, QRIS, BI-FAST, BCA Virtual Account, GoPay, OVO, DANA, ShopeePay, dll.) ini.\n"
            "Kembalikan HANYA JSON valid dengan skema:\n"
            '{"transaction_type": string|null, "direction": "expense"|"income"|"transfer"|"unknown", '
            '"merchant": string|null, "note": string|null, "items": string[], '
            '"amount": integer|null, "fee": integer, "total_amount": integer|null, "date": "YYYY-MM-DD"|null, '
            '"category": string|null, "source_bank": string|null, "source_account_no": string|null, '
            '"target_bank": string|null, "target_account_no": string|null, "account": string|null}\n'
            "Aturan ketat:\n"
            "1. transaction_type: jenis transaksi persis yang tampil di bukti (misal 'QRIS', 'Transfer ke BCA', 'BI-FAST', 'Transfer Online', 'BCA Virtual Account', 'Debit', 'Tarik Tunai', 'Transfer Masuk').\n"
            "2. direction: isi 'transfer' jika bukti transfer antar rekening/bank atau top-up e-wallet/VA; 'income' jika bukti uang masuk/kredit; 'expense' jika struk belanja/QRIS/pembayaran tagihan; 'unknown' jika ragu.\n"
            "3. merchant: nama toko/restoran/merchant/penerima (atau pengirim jika transfer masuk) yang singkat & bersih. "
            "JANGAN isi 'BCA', 'myBCA', 'm-BCA', 'Berhasil', atau 'Transaksi Berhasil'.\n"
            "4. note: isi kolom BERITA / CATATAN / KETERANGAN pada bukti transfer (null jika kosong atau '-').\n"
            "5. items: maksimal 4 nama barang/menu untuk struk kasir (tanpa kode/harga). Kosongkan [] untuk bukti transfer bank.\n"
            "6. amount: NOMINAL POKOK transaksi/transfer dalam Rupiah bulat sebagai integer murni (abaikan '.00' / ',00' sen!). "
            "Contoh 'IDR 32,000.00' -> 32000.\n"
            "7. fee: BIAYA ADMIN / BIAYA TRANSAKSI dalam Rupiah bulat (0 jika gratis atau tidak ada).\n"
            "8. total_amount: TOTAL AKHIR YANG DIBAYAR/DIDEBIT dalam Rupiah bulat (jika tidak ada biaya admin, samakan dengan amount). "
            "Pada struk kasir ambil GRAND TOTAL / TOTAL BAYAR (JANGAN ambil uang Tunai diterima atau Kembalian).\n"
            "9. date: tanggal transaksi dalam format YYYY-MM-DD (atau null jika tidak terbaca).\n"
            f"10. category: PRIORITASKAN isi BERITA (note) & catatan pengguna, lalu nama penerima/merchant, lalu transaction_type. "
            f"Pilih SATU nama kategori PERSIS dari daftar pengeluaran [{cats_text}] (atau daftar pemasukan [{inc_cats_text}] jika uang masuk).\n"
            "11. source_bank & source_account_no: nama bank/e-wallet sumber & nomor rekening sumber persis seperti yang tampil (boleh mengandung '*' atau 'X' jika disamarkan, misal '***7890').\n"
            "12. target_bank & target_account_no: nama bank/e-wallet/VA tujuan & nomor rekening/VA tujuan persis seperti yang tampil.\n"
            f"13. account: jika sumber pembayaran cocok dengan salah satu dompet di [{accs_text}], pilih nama dompet itu PERSIS; jika tidak yakin, isi null."
            f"{context_line}"
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

        merchant = _clean_str(data.get("merchant"), 100)
        note = _clean_str(data.get("note"), 160)
        tx_type = _clean_str(data.get("transaction_type"), 60)
        direction = (_clean_str(data.get("direction"), 20) or "unknown").lower()
        if direction not in {"expense", "income", "transfer", "unknown"}:
            direction = "unknown"
        raw_items = data.get("items") if isinstance(data.get("items"), list) else []
        items = [str(it).strip()[:45] for it in raw_items if str(it).strip()][:4]
        amount = _parse_positive_int(data.get("amount"))
        fee = _parse_positive_int(data.get("fee"), allow_zero=True) or 0
        total_amount = _parse_positive_int(data.get("total_amount"))
        if amount is None and total_amount is not None:
            amount = max(100, total_amount - fee) if total_amount > fee else total_amount
        tx_date = _parse_iso_date(data.get("date"))
        cat_hint = _clean_str(data.get("category"), 80)
        acc_hint = _clean_str(data.get("account"), 80)
        source_bank = _clean_str(data.get("source_bank"), 60)
        source_account_no = _clean_str(data.get("source_account_no"), 40)
        target_bank = _clean_str(data.get("target_bank"), 60)
        target_account_no = _clean_str(data.get("target_account_no"), 40)

        if not merchant and not amount and not total_amount and not items and not note:
            return None

        amount_opts = sorted({v for v in (amount, total_amount) if v})
        raw_summary = " ".join(p for p in (tx_type, merchant, note, " ".join(items)) if p).strip()
        return {
            "transaction_type": tx_type,
            "direction": direction,
            "merchant": merchant,
            "note": note,
            "items": items,
            "amount": amount,
            "fee": fee,
            "total_amount": total_amount,
            "amount_options": amount_opts,
            "date": tx_date,
            "category_hint": cat_hint,
            "account_hint": acc_hint,
            "source_bank": source_bank,
            "source_account_no": source_account_no,
            "target_bank": target_bank,
            "target_account_no": target_account_no,
            "engine": "gemini",
            "raw_text": raw_summary,
        }
    except Exception as exc:
        logger.warning("Gemini Vision receipt scan failed: %s", exc)
        return None


def _format_description(merchant: str | None, items: list[str], fallback: str = "") -> str:
    return format_receipt_description(merchant=merchant, items=items, fallback=fallback)


def _enrich_category(
    db: Session,
    owner_id: str,
    parsed: dict,
    raw_text: str,
    cats: list[dict],
    kind: str = "expense",
    note: str | None = None,
) -> tuple[str | None, str | None]:
    if kind == "transfer":
        return None, None
    cat_id, cat_name = None, None
    hint = (parsed.get("category_hint") or "").strip().lower()
    if hint:
        target_cats = [c for c in cats if c["kind"] == kind and not c["archived"]]
        exact = next((c for c in target_cats if c["name"].strip().lower() == hint), None)
        if not exact:
            exact = next(
                (c for c in target_cats if hint in c["name"].strip().lower() or c["name"].strip().lower() in hint),
                None,
            )
        if exact:
            cat_id, cat_name = exact["id"], exact["name"]

    if not cat_id:
        recent_tx = [
            {"description": t.description, "category_id": t.category_id}
            for t in db.scalars(
                select(Transaction)
                .where(Transaction.owner_id == owner_id, Transaction.kind == kind, Transaction.category_id.is_not(None))
                .order_by(Transaction.date.desc(), Transaction.created_at.desc())
                .limit(100)
            ).all()
        ]
        cat_id, cat_name = infer_category(cats, recent_tx, raw_text, parsed.get("merchant"), kind=kind, note=note)

    return cat_id, cat_name


def _analyze_receipt(
    db: Session,
    owner_id: str,
    content: bytes,
    caption_account_id: str | None = None,
    caption_note: str | None = None,
) -> tuple[dict, str]:
    all_cats = [
        {"id": c.id, "name": c.name, "kind": c.kind, "archived": c.archived}
        for c in db.scalars(select(Category).where(Category.owner_id == owner_id)).all()
    ]
    expense_cat_names = [c["name"] for c in all_cats if c["kind"] == "expense" and not c["archived"]]
    income_cat_names = [c["name"] for c in all_cats if c["kind"] == "income" and not c["archived"]]
    accounts = list(db.scalars(select(Account).where(Account.owner_id == owner_id)).all())
    account_names = [a.name for a in accounts]
    default_account_id = get_settings(db, owner_id).get("default_account_id")

    ai_res = _scan_with_gemini(
        content,
        expense_cat_names,
        account_names,
        income_category_names=income_cat_names,
        extra_context=caption_note,
    )
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

    resolved = resolve_receipt_classification(
        ai_res=ai_res,
        accounts=accounts,
        default_account_id=default_account_id,
        caption_account_id=caption_account_id,
        caption_note=caption_note,
    )
    cat_id, cat_name = _enrich_category(
        db,
        owner_id,
        ai_res,
        ai_res.get("raw_text", ""),
        all_cats,
        kind=resolved["kind"],
        note=resolved["note"],
    )

    result = {
        "kind": resolved["kind"],
        "merchant": resolved["description"],
        "merchant_name": ai_res.get("merchant"),
        "transaction_type": resolved["transaction_type"],
        "note": resolved["note"],
        "items": ai_res.get("items") or [],
        "amount": resolved["amount"],
        "fee": resolved["fee"],
        "amount_options": ai_res.get("amount_options") or ([resolved["amount"]] if resolved["amount"] else []),
        "date": ai_res.get("date") or datetime.now(JAKARTA).date().isoformat(),
        "category_id": cat_id,
        "category_name": cat_name,
        "account_id": resolved["account_id"],
        "account_name": resolved["account_name"],
        "to_account_id": resolved["to_account_id"],
        "to_account_name": resolved["to_account_name"],
        "account_guessed": resolved["account_guessed"],
        "source_account_masked": resolved["source_account_masked"],
        "target_account_masked": resolved["target_account_masked"],
        "engine": ai_res.get("engine", "gemini"),
    }
    return result, ai_res.get("raw_text", "")


def scan_receipt_auto(db: Session, owner_id: str, filename: str, content: bytes) -> dict:
    """Directly scan a receipt image with Gemini Vision to auto-fill transaction fields."""
    with open_image(content) as im:
        im.verify()
    enriched, text = _analyze_receipt(db, owner_id, content)
    fallback_name = filename.rsplit(".", 1)[0].replace("_", " ").replace("-", " ").strip() or "Belanja"
    return {
        "kind": enriched["kind"],
        "merchant": enriched.get("merchant") or fallback_name,
        "merchant_name": enriched.get("merchant_name") or fallback_name,
        "transaction_type": enriched.get("transaction_type"),
        "note": enriched.get("note"),
        "items": enriched.get("items") or [],
        "amount": enriched.get("amount"),
        "fee": enriched.get("fee", 0),
        "amount_options": enriched.get("amount_options", []),
        "date": enriched.get("date"),
        "category_id": enriched.get("category_id"),
        "category_name": enriched.get("category_name"),
        "account_id": enriched.get("account_id"),
        "account_name": enriched.get("account_name"),
        "to_account_id": enriched.get("to_account_id"),
        "to_account_name": enriched.get("to_account_name"),
        "account_guessed": enriched.get("account_guessed", False),
        "engine": enriched.get("engine", "gemini"),
        "text": text.strip()[:1000],
    }


def process_receipt(
    db: Session,
    owner_id: str,
    job_id: str,
    caption_account_id: str | None = None,
    caption_note: str | None = None,
) -> dict:
    job = get_job(db, owner_id, job_id, lock=True)
    if job.kind != "receipt":
        raise HTTPException(404, "Struk tidak ditemukan.")
    if job.status in ("review", "done"):
        return {"id": job.id, "status": job.status, **job.result}
    result, _ = _analyze_receipt(
        db,
        owner_id,
        load_file(job),
        caption_account_id=caption_account_id,
        caption_note=caption_note,
    )
    result["candidates"] = []
    if result["amount"] and result["date"]:
        day = date.fromisoformat(result["date"])
        matches = db.scalars(
            select(Transaction)
            .where(
                Transaction.owner_id == owner_id,
                Transaction.kind == result["kind"],
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
