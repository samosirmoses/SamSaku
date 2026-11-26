"""Deterministic wallet matching, BCA VA prefix detection, and receipt classification."""
import re
from typing import Iterable

# Common BCA Virtual Account prefixes for Indonesian e-wallets
BCA_VA_PREFIXES: dict[str, tuple[str, ...]] = {
    "70001": ("gopay",),
    "39358": ("ovo",),
    "3901": ("dana",),
    "09110": ("linkaja",),
    "122": ("shopeepay",),
    "112": ("shopeepay",),
}

# Provider keywords used to match bank/e-wallet names cleanly (blu kept distinct from bca)
PROVIDER_KEYWORDS: dict[str, tuple[str, ...]] = {
    "blu": ("blu", "bca digital"),
    "bca": ("mybca", "m-bca", "mbca", "bca"),
    "mandiri": ("mandiri", "livin"),
    "bri": ("brimo", "bri"),
    "bni": ("wondr", "bni"),
    "bsi": ("bsi", "syariah indonesia"),
    "cimb": ("cimb", "niaga", "octo"),
    "permata": ("permata",),
    "jago": ("jago",),
    "seabank": ("seabank", "sea bank"),
    "gopay": ("gopay", "go-pay", "gojek"),
    "ovo": ("ovo",),
    "dana": ("dana",),
    "shopeepay": ("shopeepay", "shopee pay", "shopee"),
    "linkaja": ("linkaja", "link aja"),
    "tunai": ("tunai", "cash"),
}


def digits_only(value: str | None) -> str:
    if not value:
        return ""
    return re.sub(r"\D", "", str(value))


def trailing_visible_digits(raw: str | None) -> str:
    """Return the trailing contiguous digits (handles masked m-BCA like '***7890' or '123***890')."""
    if not raw:
        return ""
    cleaned = re.sub(r"[\s.\-]+", "", str(raw).strip())
    m = re.search(r"(\d+)$", cleaned)
    return m.group(1) if m else ""


def mask_account_number(raw: str | None) -> str | None:
    """Mask raw account/phone number to '****7890' for safe storage in source_events."""
    if not raw:
        return None
    tail = trailing_visible_digits(raw)
    if len(tail) >= 4:
        return f"****{tail[-4:]}"
    digits = digits_only(raw)
    if len(digits) >= 4:
        return f"****{digits[-4:]}"
    return None


def _detect_providers(text: str | None) -> set[str]:
    if not text:
        return set()
    low = text.lower()
    found: set[str] = set()
    # Check blu before bca so "BCA Digital / blu" does not falsely tag as regular BCA
    for provider, keywords in PROVIDER_KEYWORDS.items():
        if provider == "bca" and "blu" in found:
            continue
        for kw in keywords:
            if re.search(rf"(?<![a-z0-9]){re.escape(kw)}(?![a-z0-9])", low):
                found.add(provider)
                break
    return found


def _phone_variants(digits: str) -> set[str]:
    variants = {digits}
    if digits.startswith("628") and len(digits) >= 10:
        variants.add("0" + digits[2:])
    elif digits.startswith("08") and len(digits) >= 9:
        variants.add("62" + digits[1:])
    return variants


def _strip_va_prefix(digits: str) -> tuple[str | None, set[str]]:
    """If digits start with a known BCA VA e-wallet prefix, return (stripped_number, provider_hints)."""
    for prefix, providers in sorted(BCA_VA_PREFIXES.items(), key=lambda kv: len(kv[0]), reverse=True):
        if digits.startswith(prefix) and len(digits) - len(prefix) >= 8:
            return digits[len(prefix):], set(providers)
    return None, set()


def _account_providers(acc) -> set[str]:
    return _detect_providers(f"{acc.name} {acc.code}")


def _masked_pattern_matches(raw_no: str, reg_digits: str) -> bool:
    """Match middle/edge-masked account numbers like myBCA '883 - 2** - **41' against full registered digits."""
    compact = re.sub(r"[\s.\-]+", "", str(raw_no).strip())
    if not re.search(r"[*xX]", compact):
        return False
    visible_digits = re.sub(r"\D", "", compact)
    if len(visible_digits) < 4:
        return False
    # Exact-length wildcard match (e.g., '8832****41' -> '^8832\\d\\d\\d\\d41$')
    exact_rx = "^" + "".join(r"\d" if ch in "*xX" else re.escape(ch) for ch in compact if ch.isdigit() or ch in "*xX") + "$"
    if re.fullmatch(exact_rx, reg_digits):
        return True
    # Flexible-length wildcard match for variable star counts (e.g., '***7890' or '883***41')
    flex_parts = re.split(r"[*xX]+", re.sub(r"[^\d*xX]", "", compact))
    flex_rx = "^" + r"\d+".join(re.escape(p) for p in flex_parts) + "$"
    return bool(re.fullmatch(flex_rx, reg_digits))


def match_account_by_number(
    accounts: Iterable,
    raw_no: str | None,
    bank_hint: str | None = None,
    merchant_hint: str | None = None,
    exclude_id: str | None = None,
):
    """Match an extracted account/VA number to a registered wallet using exact, masked-wildcard, VA, and suffix scoring."""
    if not raw_no:
        return None
    full_digits = digits_only(raw_no)
    tail = trailing_visible_digits(raw_no)
    has_mask = bool(re.search(r"[*xX]", str(raw_no)))
    if len(tail) < 4 and len(full_digits) < 4:
        return None

    va_stripped, va_providers = _strip_va_prefix(full_digits) if not has_mask else (None, set())
    hint_providers = _detect_providers(f"{bank_hint or ''} {merchant_hint or ''}") | va_providers
    ext_variants = _phone_variants(full_digits) if (full_digits and not has_mask) else set()
    if va_stripped:
        ext_variants |= _phone_variants(va_stripped)

    scored: list[tuple[int, object]] = []
    for acc in accounts:
        if exclude_id and acc.id == exclude_id:
            continue
        reg = digits_only(getattr(acc, "account_number", None))
        if len(reg) < 4:
            continue
        reg_variants = _phone_variants(reg)

        base_score = 0
        if ext_variants & reg_variants:
            base_score = 100
        elif has_mask and _masked_pattern_matches(raw_no, reg):
            base_score = 98
        elif va_stripped and any(v.endswith(r) or r.endswith(v) for v in _phone_variants(va_stripped) for r in reg_variants if min(len(v), len(r)) >= 8):
            base_score = 95
        elif len(tail) >= 4:
            overlap = min(len(tail), len(reg))
            if overlap >= 4 and tail[-overlap:] == reg[-overlap:]:
                base_score = 60 + min(overlap, 10) * 3

        if base_score == 0:
            continue

        acc_provs = _account_providers(acc)
        if hint_providers and acc_provs:
            if hint_providers & acc_provs:
                base_score += 30
            else:
                base_score -= 25
        elif va_providers and getattr(acc, "kind", "") == "ewallet":
            base_score += 10

        scored.append((base_score, acc))

    if not scored:
        return None
    scored.sort(key=lambda item: item[0], reverse=True)
    best_score, best_acc = scored[0]
    if best_score < 50:
        return None
    # Reject ambiguous tie at the top
    if len(scored) > 1 and scored[1][0] == best_score:
        return None
    return best_acc


def match_account_by_bank(accounts: Iterable, bank_hint: str | None, exclude_id: str | None = None):
    """Return (account, status) where status is 'matched', 'ambiguous', or 'none'."""
    if not bank_hint:
        return None, "none"
    hint_low = bank_hint.strip().lower()
    hint_provs = _detect_providers(bank_hint)
    candidates = []
    for acc in accounts:
        if exclude_id and acc.id == exclude_id:
            continue
        name_low = acc.name.strip().lower()
        code_low = acc.code.strip().lower()
        acc_provs = _account_providers(acc)
        if (
            name_low == hint_low
            or code_low == hint_low
            or (hint_provs and (hint_provs & acc_provs))
            or (len(hint_low) >= 3 and (hint_low in name_low or name_low in hint_low))
        ):
            candidates.append(acc)
    if len(candidates) == 1:
        return candidates[0], "matched"
    if len(candidates) > 1:
        return None, "ambiguous"
    return None, "none"


def format_receipt_description(
    merchant: str | None,
    note: str | None = None,
    items: list[str] | None = None,
    transaction_type: str | None = None,
    fallback: str = "Foto struk",
) -> str:
    base = (merchant or "").strip()
    clean_note = (note or "").strip()
    if clean_note in {"-", "—", "n/a", "none"}:
        clean_note = ""
    clean_items = [x.strip() for x in (items or []) if x and x.strip()][:4]
    clean_type = (transaction_type or "").strip()

    if base and clean_note:
        return f"{base} — {clean_note}"[:180]
    if base and clean_items:
        return f"{base} — {', '.join(clean_items)}"[:180]
    if base and clean_type:
        return f"{base} ({clean_type})"[:180]
    if base:
        return base[:180]
    if clean_note:
        return clean_note[:180]
    if clean_items:
        return ", ".join(clean_items)[:180]
    return fallback[:180]


def resolve_receipt_classification(
    ai_res: dict,
    accounts: list,
    default_account_id: str | None = None,
    caption_account_id: str | None = None,
    caption_note: str | None = None,
) -> dict:
    """Resolve final kind (expense/income/transfer), wallets, amount/fee, and description."""
    acc_by_id = {a.id: a for a in accounts}
    default_acc = acc_by_id.get(default_account_id) if default_account_id else None
    caption_acc = acc_by_id.get(caption_account_id) if caption_account_id else None

    source_no = ai_res.get("source_account_no")
    target_no = ai_res.get("target_account_no")
    source_bank = ai_res.get("source_bank") or ai_res.get("account_hint")
    target_bank = ai_res.get("target_bank")
    merchant = ai_res.get("merchant")
    direction = (ai_res.get("direction") or "unknown").strip().lower()
    tx_type = (ai_res.get("transaction_type") or "").strip() or None
    note = (ai_res.get("note") or "").strip() or (caption_note or "").strip() or None

    source_acc = match_account_by_number(accounts, source_no, source_bank)
    target_acc = match_account_by_number(accounts, target_no, target_bank, merchant)

    # Guard against Gemini putting the exact same account number in both source and target
    if source_acc and target_acc and source_acc.id == target_acc.id:
        if direction == "income":
            source_acc = None
        else:
            target_acc = None

    has_foreign_source_no = len(trailing_visible_digits(source_no)) >= 4 and source_acc is None

    kind = "expense"
    account_id: str | None = None
    to_account_id: str | None = None
    account_guessed = False

    if target_acc and source_acc and source_acc.id != target_acc.id:
        kind = "transfer"
        account_id = caption_acc.id if (caption_acc and caption_acc.id != target_acc.id) else source_acc.id
        to_account_id = target_acc.id
    elif target_acc and source_acc is None:
        if direction == "income" or has_foreign_source_no:
            kind = "income"
            account_id = target_acc.id
        else:
            # Target is our wallet and source account number was not visible (e.g. cropped BCA VA top-up)
            kind = "transfer"
            to_account_id = target_acc.id
            if caption_acc and caption_acc.id != target_acc.id:
                account_id = caption_acc.id
            else:
                bank_acc, _ = match_account_by_bank(accounts, source_bank, exclude_id=target_acc.id)
                if bank_acc:
                    account_id = bank_acc.id
                elif default_acc and default_acc.id != target_acc.id:
                    account_id = default_acc.id
                    account_guessed = True
    elif direction == "income":
        kind = "income"
        if caption_acc:
            account_id = caption_acc.id
        elif target_acc:
            account_id = target_acc.id
        elif source_acc:
            account_id = source_acc.id
        else:
            bank_acc, _ = match_account_by_bank(accounts, target_bank or source_bank)
            if bank_acc:
                account_id = bank_acc.id
            elif default_acc:
                account_id = default_acc.id
                account_guessed = True
    else:
        kind = "expense"
        if caption_acc:
            account_id = caption_acc.id
        elif source_acc:
            account_id = source_acc.id
        else:
            bank_acc, _ = match_account_by_bank(accounts, source_bank)
            if bank_acc:
                account_id = bank_acc.id
            elif default_acc:
                account_id = default_acc.id
                account_guessed = True

    base_amount = ai_res.get("amount")
    fee_raw = ai_res.get("fee") or 0
    total_amount = ai_res.get("total_amount")

    if kind == "transfer":
        if base_amount is None and total_amount is not None:
            final_amount = max(1, total_amount - fee_raw) if total_amount > fee_raw else total_amount
        else:
            final_amount = base_amount
        final_fee = fee_raw if isinstance(fee_raw, int) and fee_raw > 0 else 0
    elif kind == "expense":
        if total_amount is not None and (base_amount is None or total_amount >= base_amount):
            final_amount = total_amount
        elif base_amount is not None and fee_raw:
            final_amount = base_amount + fee_raw
        else:
            final_amount = base_amount or total_amount
        final_fee = 0
    else:
        final_amount = base_amount or total_amount
        final_fee = 0

    from_acc_obj = acc_by_id.get(account_id) if account_id else None
    to_acc_obj = acc_by_id.get(to_account_id) if to_account_id else None

    fallback_desc = f"Transfer ke {to_acc_obj.name}" if (kind == "transfer" and to_acc_obj) else "Foto struk"
    description = format_receipt_description(
        merchant=merchant,
        note=note,
        items=ai_res.get("items") or [],
        transaction_type=tx_type,
        fallback=fallback_desc,
    )

    return {
        "kind": kind,
        "account_id": account_id,
        "account_name": from_acc_obj.name if from_acc_obj else None,
        "to_account_id": to_account_id,
        "to_account_name": to_acc_obj.name if to_acc_obj else None,
        "account_guessed": account_guessed,
        "amount": final_amount,
        "fee": final_fee,
        "transaction_type": tx_type,
        "note": note,
        "description": description,
        "source_account_masked": mask_account_number(source_no),
        "target_account_masked": mask_account_number(target_no),
    }
