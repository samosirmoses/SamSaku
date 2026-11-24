import hashlib
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from sqlalchemy import select

from .calculations import rupiah
from .db import lock_owner
from .ledger import post_transaction
from .models import Account, Category, Evidence, Transaction
from .receipt_text import _extract_date, infer_category
from .schemas import EventIn, TransactionIn

JAKARTA = ZoneInfo("Asia/Jakarta")


def redact(text):
    text = re.sub(r"(?im)((?:rekening|account|kartu|card|pan)(?:\s+(?:asal|tujuan|number|no\.?))?\s*[:#-]?\s*)[\d -]{7,25}(\d{4})\b",
                  r"\1****\2", text)
    return re.sub(r"(?i)((?:kode\s+)?(?:OTP|PIN|password)\s*[:#-]?\s*)\d{4,8}\b", r"\1[disamarkan]", text)


def draft(db, owner_id, source, text, event_date):
    accounts = db.scalars(select(Account).where(Account.owner_id == owner_id)).all()
    if source == "telegram":
        amounts = re.findall(r"(?<!\w)(?:rp\s*)?\d[\d.]*(?:,00)?(?:rb|jt|k)?(?!\w)", text.lower())
        account = next((a for a in accounts if a.name.lower() in text.lower() or a.code.lower() in text.lower()), None)
        kind = "income" if re.search(r"\b(gaji|bonus|pemasukan)\b", text, re.I) else "expense"
        cat_id = None
        if kind == "expense":
            cats = [
                {"id": c.id, "name": c.name, "kind": c.kind, "archived": c.archived}
                for c in db.scalars(select(Category).where(Category.owner_id == owner_id)).all()
            ]
            cat_id, _ = infer_category(cats, [], text, text)
        payload = {
            "date": event_date.isoformat(),
            "description": text[:500],
            "kind": kind,
            "account_id": account.id if account else None,
            "amount": rupiah(amounts[0]) if len(amounts) == 1 else None,
        }
        if cat_id:
            payload["category_id"] = cat_id
        return payload, False
    path = os.getenv("SAMSAKU_PARSER_RULES")
    if not path and Path("/srv/parser-rules.local.json").is_file():
        path = "/srv/parser-rules.local.json"
    if not path:
        return {}, False
    rules = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    for rule in rules:
        if rule.get("source") != source:
            continue
        matched = re.fullmatch(rule["pattern"], text.strip(), flags=re.IGNORECASE | re.DOTALL)
        if not matched:
            continue
        groups = matched.groupdict()
        amount = rupiah(groups.get("amount") or "")
        account = next((a for a in accounts if a.code == rule["account_code"]), None)
        ref = (groups.get("ref") or "").strip()[:480]
        parsed_date = None
        if groups.get("date"):
            if rule.get("date_format"):
                try:
                    parsed_date = datetime.strptime(groups["date"].strip(), rule["date_format"]).date()
                except ValueError:
                    pass
            if parsed_date is None:
                iso_date = _extract_date(groups["date"])
                if iso_date:
                    parsed_date = datetime.strptime(iso_date, "%Y-%m-%d").date()
        merchant_desc = redact((groups.get("merchant") or text).strip())[:500]
        result = {"kind": rule["kind"], "amount": amount, "account_id": account.id if account else None,
                  "date": (parsed_date or event_date).isoformat(), "description": merchant_desc}
        if rule["kind"] == "expense":
            cats = [
                {"id": c.id, "name": c.name, "kind": c.kind, "archived": c.archived}
                for c in db.scalars(select(Category).where(Category.owner_id == owner_id)).all()
            ]
            cat_id, _ = infer_category(cats, [], text, merchant_desc)
            if cat_id:
                result["category_id"] = cat_id
        # An explicit success-only template and provider reference are required for automatic posting.
        date_ok = parsed_date is not None or (not groups.get("date") and rule.get("use_delivery_date") is True)
        automatic = bool(account and amount and amount <= 9_000_000_000_000_000 and ref and date_ok and rule.get("verified") is True
                         and rule["kind"] in {"income", "expense"})
        if ref:
            result["source_ref"] = ref
        return result, automatic
    return {}, False


def ingest(db, owner_id, source, data: EventIn):
    lock_owner(db, owner_id)
    raw = data.text.strip()
    digest = hashlib.sha256(raw.encode()).hexdigest()
    existing = db.scalars(select(Evidence).where(Evidence.owner_id == owner_id, Evidence.source == source,
                                   Evidence.external_id == data.external_id)).all()
    for item in existing:
        if item.digest == digest:
            return item
    when = data.occurred_at or datetime.now(timezone.utc)
    if when.tzinfo is None:
        when = when.replace(tzinfo=JAKARTA)
    parsed, auto = draft(db, owner_id, source, raw, when.astimezone(JAKARTA).date())
    event = Evidence(owner_id=owner_id, source=source, external_id=data.external_id,
                     occurred_at=when.astimezone(timezone.utc), digest=digest, text=redact(raw), parsed=parsed, status="review")
    db.add(event)
    if auto and not existing:
        ref = parsed["source_ref"]
        known = db.scalar(select(Transaction).where(Transaction.owner_id == owner_id, Transaction.source == source,
                                                     Transaction.source_ref == ref))
        if known:
            same = (known.account_id == parsed["account_id"] and known.kind == parsed["kind"]
                    and known.amount == parsed["amount"] and known.date.isoformat() == parsed["date"])
            if same:
                event.transaction_id, event.status = known.id, "linked"
        else:
            # Similar purchases remain separate candidates for owner review.
            candidate = db.scalar(select(Transaction.id).where(Transaction.owner_id == owner_id,
                Transaction.account_id == parsed["account_id"], Transaction.amount == parsed["amount"],
                Transaction.date == TransactionIn.model_validate(parsed).date).limit(1))
            if not candidate:
                tx = post_transaction(db, owner_id, TransactionIn.model_validate(parsed), source, ref)
                event.transaction_id, event.status = tx.id, "posted"
    db.flush()
    return event
