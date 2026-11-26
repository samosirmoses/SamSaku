"""Extract date, merchant/amount hints, and infer expense category from Indonesian text."""
import re
from datetime import datetime

from .xlsx import money

MONTHS_ID = {
    "jan": 1, "januari": 1,
    "feb": 2, "februari": 2,
    "mar": 3, "maret": 3,
    "apr": 4, "april": 4,
    "mei": 5, "may": 5,
    "jun": 6, "juni": 6,
    "jul": 7, "juli": 7,
    "agu": 8, "ags": 8, "agustus": 8, "aug": 8,
    "sep": 9, "sept": 9, "september": 9,
    "okt": 10, "oktober": 10, "oct": 10,
    "nov": 11, "november": 11, "nop": 11,
    "des": 12, "desember": 12, "dec": 12,
}

CATEGORY_RULES = [
    (
        r"makan|minum|kuliner|konsumsi|food|resto|kopi|jajan",
        r"\b(kopi|coffee|cafe|kafe|resto|restoran|warung|rm|rumah\s+makan|bakso|mie|ayam|nasi|sate|soto|bebek|geprek|padang|warteg|sushi|ramen|pizza|burger|bakery|roti|cake|kue|teh|tea|boba|mixue|janji\s+jiwa|kenangan|fore|tuku|starbucks|kfc|mcd|mcdonald|hokben|solaria|gofood|grabfood|shopeefood|minuman|makanan|juice|jus|dimsum|martabak|seblak|steak|seafood|pecel|bubur)\b",
    ),
    (
        r"belanja|kebutuhan|grocer|rumah|mart|pasar|dapur|shop",
        r"\b(indomaret|alfamart|alfamidi|superindo|hypermart|transmart|lottemart|farmers|ranch\s+market|hero|tiptop|yogya|borma|minimarket|supermarket|swalayan|pasar|tokopedia|shopee|lazada|blibli|tiktok|ikea|ace\s+hardware|mr\s*diy|miniso|uniqlo|zara|sabun|shampoo|deterjen|beras|minyak|gula|telur|susu|popok|tisu)\b",
    ),
    (
        r"transport|jalan|kendaraan|bensin|bbm|parkir|tol|ojek",
        r"\b(pertamina|shell|vivo|spbu|pertalite|pertamax|solar|dexlite|bensin|bbm|parkir|parking|tol|e-toll|flazz|emoney|brizzi|tapcash|gojek|goride|gocar|grab|grabbike|grabcar|maxim|indrive|bluebird|taksi|taxi|kereta|kai|krl|mrt|lrt|transjakarta|busway|traveloka|pesawat|bengkel|servis|oli)\b",
    ),
    (
        r"tagih|utilit|listrik|air|internet|pulsa|langganan|bill",
        r"\b(pln|listrik|token|pdam|telkom|indihome|biznet|firstmedia|myrepublic|wifi|internet|telkomsel|indosat|xl|axis|smartfren|pulsa|paket\s+data|pascabayar|bpjs|pajak|iuran|ipl|netflix|spotify|youtube|icloud)\b",
    ),
    (
        r"sehat|medis|obat|dokter|apotek|klinik",
        r"\b(apotek|apotik|kimia\s+farma|k-24|k24|century|guardian|watsons|halodoc|alodokter|rumah\s+sakit|klinik|puskesmas|dokter|gigi|obat|vitamin|prodia)\b",
    ),
    (
        r"hibur|hobi|rekreasi|nonton|game|bioskop",
        r"\b(xxi|cgv|cinepolis|bioskop|cinema|steam|playstation|konser|karaoke|timezone|wisata|hotel)\b",
    ),
]


def _extract_date(text: str) -> str | None:
    for value in re.findall(r"\b(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4})\b", text):
        norm = value.replace("/", "-").replace(".", "-")
        for fmt in ("%Y-%m-%d", "%d-%m-%Y"):
            try:
                return datetime.strptime(norm, fmt).date().isoformat()
            except ValueError:
                pass
    for d_str, m_str, y_str in re.findall(r"\b(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})\b", text):
        m_num = MONTHS_ID.get(m_str.lower())
        if m_num:
            try:
                return datetime(int(y_str), m_num, int(d_str)).date().isoformat()
            except ValueError:
                pass
    for value in re.findall(r"\b\d{1,2}[-/]\d{1,2}[-/]\d{2}\b", text):
        try:
            return datetime.strptime(value.replace("/", "-"), "%d-%m-%y").date().isoformat()
        except ValueError:
            pass
    return None


def extract(text: str) -> dict:
    lines = [s.strip() for s in text.splitlines() if s.strip()]
    merchant = next(
        (
            s[:100]
            for s in lines[:6]
            if re.search(r"[A-Za-z]{3}", s)
            and not re.search(r"(?i)struk|receipt|invoice|tanggal|alamat|telepon|telp|npwp|kasir|^jl\b", s)
        ),
        None,
    )
    amounts = set()
    rx = r"(?<!\d)(?:Rp\.?\s*|IDR\s*)?([0-9]{1,3}(?:[.,]\d{3})+(?:[.,]00)?|[0-9]{4,9}(?:[.,]00)?)(?![\d,.])"
    for line in lines:
        if re.search(
            r"(?i)sub\s*total|kembali|kembalian|change|cashback|tunai|cash\s+(?:paid|received)|diskon|discount|hemat|dpp|ppn|tax|pajak",
            line,
        ):
            continue
        if re.search(
            r"(?i)\b(grand\s*total|total\s*bayar|total\s*belanja|jumlah\s*bayar|amount\s*due|harus\s*dibayar|netto|total|tagihan|qris|edc|debit\s*bca)\b",
            line,
        ):
            match = re.findall(rx, line, re.I)
            if match:
                try:
                    val = money(match[-1])
                    if 500 <= val <= 500_000_000:
                        amounts.add(val)
                except ValueError:
                    pass
    if not amounts:
        fallback = set()
        for line in lines:
            if re.search(r"(?i)kembali|change|cashback|tunai|cash|telp|npwp|no\.?\s*trx|tanggal", line):
                continue
            for m in re.findall(rx, line, re.I):
                try:
                    val = money(m)
                    if 1000 <= val <= 500_000_000:
                        fallback.add(val)
                except ValueError:
                    pass
        if len(fallback) == 1:
            amounts = fallback
        elif fallback:
            return {
                "amount": max(fallback),
                "amount_options": sorted(fallback),
                "merchant": merchant,
                "date": _extract_date(text),
            }
    day = _extract_date(text)
    return {
        "amount": next(iter(amounts)) if len(amounts) == 1 else None,
        "amount_options": sorted(amounts),
        "merchant": merchant,
        "date": day,
    }


def infer_category(
    categories: list[dict],
    history: list[dict],
    text: str,
    merchant: str | None,
) -> tuple[str | None, str | None]:
    """Automatically determine expense category from history and receipt text."""
    expense_cats = [c for c in categories if c.get("kind") == "expense" and not c.get("archived")]
    if not expense_cats:
        return None, None
    cat_by_id = {c["id"]: c for c in expense_cats}
    haystack = f"{merchant or ''}\n{text or ''}".lower()

    if merchant:
        m_low = merchant.lower().strip()
        m_tokens = [w for w in re.split(r"[^a-z0-9]+", m_low) if len(w) >= 3]
        for tx in history:
            cid = tx.get("category_id")
            desc = (tx.get("description") or "").lower().strip()
            if cid and cid in cat_by_id and desc:
                if m_low in desc or desc in m_low or any(tok in desc.split() for tok in m_tokens):
                    return cid, cat_by_id[cid]["name"]

    for c in expense_cats:
        c_words = [w for w in re.split(r"[^a-z0-9]+", c["name"].lower()) if len(w) >= 4]
        if any(re.search(rf"\b{re.escape(w)}\b", haystack) for w in c_words):
            return c["id"], c["name"]

    for cat_pattern, text_pattern in CATEGORY_RULES:
        if re.search(text_pattern, haystack, re.I):
            for c in expense_cats:
                if re.search(cat_pattern, c["name"], re.I):
                    return c["id"], c["name"]

    other = next((c for c in expense_cats if re.search(r"lain|other|umum", c["name"], re.I)), None)
    if other:
        return other["id"], other["name"]
    return expense_cats[0]["id"], expense_cats[0]["name"]
