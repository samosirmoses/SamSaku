"""Exact, side-effect-free rules for Indonesian currency and monthly allocations."""
from calendar import monthrange
from datetime import date
import re


def rupiah(raw):
    value = raw.lower().strip()
    has_idr = value.startswith("idr")
    value = value.removeprefix("rp").removeprefix("idr").strip()
    match = re.fullmatch(r"(\d{1,12})(k|rb|jt)", value)
    if match:
        return int(match[1]) * (1_000_000 if match[2] == "jt" else 1_000)
    # Handle English/myBCA format like '32,000.00' or '1,250,000.00' or 'IDR 32000.00'
    if re.fullmatch(r"\d{1,3}(,\d{3})+(\.00)?", value):
        return int(value.removesuffix(".00").replace(",", ""))
    if has_idr and re.fullmatch(r"\d{1,16}\.00", value):
        return int(value.removesuffix(".00"))
    value = value.removesuffix(",00")
    if not re.fullmatch(r"(\d{1,3}(\.\d{3})+|\d{1,16})", value):
        return None
    return int(value.replace(".", ""))


def cycle(day, when):
    def boundary(year, month):
        return date(year, month, min(day, monthrange(year, month)[1]))
    here = boundary(when.year, when.month)
    index = when.year * 12 + when.month - 1 - int(when < here)
    year, month = divmod(index, 12)
    next_year, next_month = divmod(index + 1, 12)
    return boundary(year, month + 1), boundary(next_year, next_month + 1)


def divide(basis, rules, fixed_allocated):
    values = []
    remainder_index = None
    for i, rule in enumerate(rules):
        if rule["mode"] == "fixed":
            values.append(max(0, rule["value"] - fixed_allocated.get(rule["name"], 0)))
        elif rule["mode"] == "percent":
            values.append(basis * rule["value"] // 100)
        else:
            values.append(0)
            remainder_index = i
    left = basis - sum(values)
    if remainder_index is not None and left >= 0:
        values[remainder_index] = left
        left = 0
    return values, left
