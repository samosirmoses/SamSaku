"""Extract reviewed receipt fields from recognized Indonesian shop text."""
import re
from datetime import datetime

from .xlsx import money


def extract(text):
    lines = [s.strip() for s in text.splitlines() if s.strip()]
    merchant = next((s[:100] for s in lines[:5] if re.search(r"[A-Za-z]{3}",s) and not re.search(r"(?i)struk|receipt|invoice|tanggal|alamat|telepon|^jl\b", s)), None)
    amounts = set()
    rx = r"(?<!\d)(?:Rp\s*)?([0-9]{1,3}(?:\.\d{3})+(?:,00)?|[0-9]{2,}(?:,00)?)(?![\d,.])"
    for line in lines:
        if re.search(r"(?i)sub\s*total|kembali|change|cashback|tunai|cash\s+(?:paid|received)",line):
            continue
        if re.search(r"(?i)\b(total|jumlah bayar|amount due)\b",line):
            match = re.findall(rx,line,re.I)
            if match:
                try:
                    amounts.add(money(match[-1]))
                except ValueError:
                    pass
    day = None
    for value in re.findall(r"\b(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{4})\b", text):
        for fmt in ("%Y-%m-%d", "%d-%m-%Y"):
            try:
                day = datetime.strptime(value.replace("/", "-"),fmt).date().isoformat()
                break
            except ValueError:
                pass
        if day:
            break
    return {"amount": next(iter(amounts)) if len(amounts) == 1 else None,
            "amount_options": sorted(amounts), "merchant": merchant, "date": day}
