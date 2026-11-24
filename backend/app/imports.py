"""Map and validate Excel rows without mutating the ledger during preview."""
import hashlib
import json
from collections import Counter
from datetime import date
from uuid import NAMESPACE_URL, uuid5

from fastapi import HTTPException
from sqlalchemy import select

from . import models
from .jobs import ImportEntry, load_file
from .ledger import balance, post_transaction
from .planning import validate_scheme
from .schemas import SchemeIn, TransactionIn

from .xlsx import as_date, inspect, KINDS, money, norm, scan, template


TABLES = {"accounts": models.Account, "categories": models.Category, "merchants": models.Merchant,
          "aliases": models.Alias, "schemes": models.Scheme}


def lookup(db, owner, table, value, kind=None):
    if not str(value or "").strip():
        return None
    model = TABLES[table]
    stmt = select(model).where(model.owner_id == owner)
    if kind:
        stmt = stmt.where(model.kind == kind)
    # A name may be ambiguous; codes take precedence.
    from sqlalchemy import func
    keys = ["id", "code", "name"] if hasattr(model, "code") else ["id", "name"]
    for field in keys:
        matches = list(db.scalars(stmt.where(func.lower(getattr(model, field)) == norm(value)).limit(2)))
        if len(matches) > 1:
            raise ValueError(f"Nama '{value}' ambigu. Gunakan kode.")
        if matches:
            return matches[0]
    return None


def need(db, owner, table, value, kind=None):
    record = lookup(db, owner, table, value, kind)
    if not record:
        raise ValueError(f"Referensi {table} '{value or ''}' belum tersedia.")
    return record


def master(db, owner, entity, v, order):
    def required(key):
        text = str(v.get(key, "")).strip()
        if not text or len(text) > 120:
            raise ValueError(f"{key}: isi 1–120 karakter.")
        return text

    if entity == "pots":
        scheme = need(db, owner, "schemes", required("scheme"))
        name, mode = required("name"), norm(required("mode"))
        mode = {"tetap":"fixed","persen":"percent","sisa":"remainder"}.get(mode, mode)
        value = money(v.get("value", 0))
        if mode not in ("fixed", "percent", "remainder") or (mode == "percent" and value > 100):
            raise ValueError("Aturan pos tidak valid.")
        rules = list(scheme.rules or [])
        existing = next((r for r in rules if norm(r["name"]) == norm(name)), {})
        rule = {**existing, "name": name, "mode": mode, "value": value, "category_ids": existing.get("category_ids", [])}
        if v.get("category"):
            rule["category_ids"] = [need(db, owner, "categories", v["category"], "expense").id]
        rules = [r for r in rules if norm(r["name"]) != norm(name)] + [rule]
        validate_scheme(db, owner, SchemeIn(name=scheme.name,cycle_day=scheme.cycle_day,rules=rules))
        if existing != rule:
            scheme.rules = rules
        return scheme, ("duplicate" if existing == rule else "update" if existing else "new"), {}

    model = TABLES[entity]
    key = "name" if entity == "aliases" else "code"
    code = required(key)
    if key == "code" and len(code) > 80:
        raise ValueError("Kode maksimal 80 karakter.")
    from sqlalchemy import func
    obj = db.scalar(select(model).where(model.owner_id == owner, func.lower(getattr(model, key)) == norm(code)))
    values = {}
    if v.get("name") or not obj:
        values["name"] = required("name")
    if entity in ("accounts", "categories") and (v.get("kind") or not obj):
        values["kind"] = KINDS.get(norm(v.get("kind")), norm(v.get("kind")))
        allowed = ("income","expense") if entity == "categories" else ("bank","cash","ewallet","wallet","investment","liability","e-wallet")
        if values["kind"] not in allowed:
            raise ValueError("Jenis kategori/dompet tidak dikenali.")
        if obj and values["kind"] != obj.kind:
            raise ValueError("Perubahan jenis master harus ditinjau melalui pengaturan.")
    if entity == "accounts":
        if ("opening_balance" in v) != ("opening_date" in v):
            raise ValueError("Tanggal dan nominal saldo awal harus diisi bersama.")
        if "opening_date" in v:
            values.update(opening_date=date.fromisoformat(as_date(v["opening_date"], order)), opening_balance=money(v["opening_balance"], signed=True))
    if entity == "categories" and v.get("parent"):
        parent = need(db, owner, entity, v["parent"], values.get("kind") or obj.kind)
        if parent.parent_id or (obj and obj.id == parent.id):
            raise ValueError("Kategori mendukung maksimal dua tingkat.")
        if obj and db.scalar(select(models.Category.id).where(models.Category.parent_id == obj.id).limit(1)):
            raise ValueError("Kategori ini memiliki anak dan harus tetap menjadi induk.")
        values["parent_id"] = parent.id
    if entity == "aliases":
        values["merchant_id"] = need(db, owner, "merchants", required("merchant")).id
    if entity == "schemes" and (v.get("cycle_day") or not obj):
        values["cycle_day"] = money(v.get("cycle_day", 1))
        if not 1 <= values["cycle_day"] <= 31:
            raise ValueError("Awal siklus harus antara 1 dan 31.")
    if obj is None:
        if key != "name":
            values[key] = code
        obj = model(id=str(uuid5(NAMESPACE_URL, f"{owner}/{entity}/{norm(code)}")), owner_id=owner, **values)
        db.add(obj)
        db.flush()
        return obj, "new", {}
    changes = {k: {"from": str(getattr(obj, k)), "to": str(val)} for k,val in values.items() if getattr(obj, k) != val}
    for key, val in values.items():
        setattr(obj, key, val)
    db.flush()
    return obj, "update" if changes else "duplicate", changes


def transaction(db, owner, job, row):
    v = row["values"]
    credit = money(v.get("credit", 0))
    debit = money(v.get("debit", 0))
    kind = KINDS.get(norm(v.get("kind")), norm(v.get("kind")))
    if debit and credit:
        raise ValueError("Kolom debit dan kredit terisi bersamaan.")
    if not kind:
        kind = "income" if credit else "expense" if debit else ""
    amount = money(v["amount"]) if "amount" in v else credit or debit
    if (debit or credit) and (amount != (debit or credit) or (kind == "income" and debit) or (kind == "expense" and credit)):
        raise ValueError("Nominal/jenis bertentangan dengan kolom debit dan kredit.")
    if amount <= 0 or kind not in ("income", "expense", "transfer", "refund"):
        raise ValueError("Nominal positif dan jenis transaksi diperlukan.")
    day = date.fromisoformat(as_date(v.get("date"), row["order"]))
    account = need(db, owner, "accounts", v.get("account"))
    if v.get("category") and kind == "transfer":
        raise ValueError("Transfer tidak memakai kategori transaksi.")
    category = None
    if v.get("category"):
        label = str(v["category"])
        wanted = "income" if kind == "income" else "expense"
        mapped = row.get("categories", {}).get(label, label)
        if mapped == "__create__":
            category = lookup(db, owner, "categories", label, wanted)
            if not category:
                code = "XLS-" + hashlib.sha256(f"{wanted}/{norm(label)}".encode()).hexdigest()[:12]
                category, _, _ = master(db, owner, "categories", {"code":code, "name":label, "kind":wanted}, row["order"])
        elif mapped != "__uncategorized__":
            category = need(db, owner, "categories", mapped, wanted)
    merchant = None
    if v.get("merchant"):
        merchant = lookup(db, owner, "merchants", v["merchant"])
        if not merchant:
            alias = lookup(db, owner, "aliases", v["merchant"])
            if alias:
                merchant = db.get(models.Merchant, alias.merchant_id)
    destination = need(db, owner, "accounts", v.get("to_account")) if kind == "transfer" else None
    fee = money(v.get("fee", 0))
    if fee and kind != "transfer":
        raise ValueError("Kolom fee digunakan untuk biaya transfer.")
    description = str(v.get("description") or v.get("merchant") or "").strip()
    def origin_ref(ref):
        return f"{account.id}/{ref}"
    ref = origin_ref(v["reference"]) if v.get("reference") else f"file/{job.digest}/{row['sheet']}/{row['row']}"
    if len(ref) > 500:
        raise ValueError("Referensi terlalu panjang.")
    txs = select(models.Transaction).where(models.Transaction.owner_id == owner)
    original_id = None
    if kind == "refund":
        original = db.scalar(txs.where(models.Transaction.source == "excel", models.Transaction.source_ref == origin_ref(v.get("original_ref", ""))))
        if not original and v.get("original_ref"):
            original = db.scalar(txs.where(models.Transaction.id == str(v["original_ref"])))
        if not original:
            raise ValueError("Refund memerlukan ID transaksi asal atau referensi pembayaran yang sudah diimpor.")
        original_id = original.id
    payload = TransactionIn(kind=kind,date=day,account_id=account.id,amount=amount,category_id=category.id if category else None,
                            description=description,to_account_id=destination.id if destination else None,fee=fee,original_id=original_id,
                            merchant_id=merchant.id if merchant else None)
    existing = db.scalar(txs.where(models.Transaction.source == "excel", models.Transaction.source_ref == ref))
    if existing:
        keys = ("kind", "account_id", "date", "amount", "to_account_id", "fee", "description", "category_id", "merchant_id","original_id")
        if any(getattr(existing, key) != getattr(payload, key) for key in keys):
            raise ValueError("Referensi sudah ada dengan nilai lain. Periksa transaksi asal.")
        return existing, "duplicate", {}, {}
    if v.get("reference"):
        provider = db.scalars(txs.where(models.Transaction.source.in_(["bca","gopay"]),
            models.Transaction.account_id==account.id, models.Transaction.source_ref==str(v["reference"]))).all()
        if provider:
            if len(provider) != 1 or (provider[0].kind, provider[0].amount, provider[0].date) != (kind, amount, day):
                raise ValueError("Referensi bukti digital bertentangan dengan rincian baris ini.")
            # Commit stores the import row's provenance against the existing payment.
            return provider[0], "duplicate", {}, {}
    similar = db.scalar(txs.where(models.Transaction.date == day, models.Transaction.account_id == account.id,
                                  models.Transaction.amount == amount, models.Transaction.kind == kind).limit(1))
    # Retain both genuine same-day purchases until the user chooses to exclude one.
    tx = post_transaction(db, owner, payload, source="excel", source_ref=ref)
    impact = {}
    if account.opening_date is not None and day >= account.opening_date:
        impact[account.code] = amount if kind in ("income", "refund") else -amount - fee
    if destination and destination.opening_date is not None and day >= destination.opening_date:
        impact[destination.code] = amount
    report = {"income": amount if kind == "income" else 0,
              "expense": amount if kind == "expense" else -amount if kind == "refund" else fee if kind == "transfer" else 0}
    return tx, "similar" if similar else "new", impact, report


def evaluate(db, owner, job, plans, *, apply=False, excluded=(), accepted=()):
    """Master references and ledger rules run against real transactional state.

    A preview uses a savepoint and rolls it back even after validation failures.
    """
    from pydantic import ValidationError
    from sqlalchemy.exc import IntegrityError
    rows = scan(load_file(job), plans)
    results, impacts, totals = [], Counter(), Counter()
    dates = []
    batch = db.begin_nested()
    try:
        for row in rows:
            key = (row["sheet"], row["row"])
            item = {k: row[k] for k in ("sheet","row","entity","values")}
            item.update(status="excluded", message="")
            if key not in excluded:
                try:
                    with db.begin_nested():
                        if row["entity"] == "transactions":
                            obj,status,impact,report = transaction(db, owner, job, row)
                            if status == "similar" and apply and key not in accepted:
                                raise ValueError("Konfirmasi potensi transaksi ganda sebelum menyimpan.")
                            impacts.update(impact)
                            totals.update(report)
                            dates.append(obj.date.isoformat())
                            if status == "similar":
                                item["message"] = "Nominal, dompet, dan tanggal mirip. Catat terpisah atau lewati."
                        else:
                            old_balance = None
                            if row["entity"] == "accounts" and row["values"].get("code"):
                                old = lookup(db, owner, "accounts", row["values"]["code"])
                                old_balance = balance(db, old) if old else None
                            obj,status,changes = master(db, owner, row["entity"], row["values"], row["order"])
                            if row["entity"] == "accounts" and status != "duplicate" and obj.opening_date:
                                impacts[obj.code] += balance(db, obj) - (old_balance or 0)
                            item["changes"] = changes
                        item["status"] = status
                        if apply:
                            db.add(ImportEntry(owner_id=owner,job_id=job.id,sheet=key[0],row=key[1],entity=row["entity"],record_id=obj.id))
                            db.flush()
                except (ValueError, HTTPException, IntegrityError, ValidationError) as err:
                    message = err.detail if isinstance(err, HTTPException) else "Baris bertentangan dengan data yang ada." if isinstance(err, IntegrityError) else str(err)
                    item.update(status="error", message=str(message)[:400])
            results.append(item)
        if apply:
            if any(r["status"] == "error" for r in results):
                raise HTTPException(409, "Terdapat kesalahan atau konflik. Periksa pratinjau kembali.")
            batch.commit()
        else:
            batch.rollback()
    except Exception:
        if batch.is_active:
            batch.rollback()
        raise
    result = {"rows": results, "counts": dict(Counter(r["status"] for r in results)),
              "income": totals["income"], "expense": totals["expense"], "impacts": dict(impacts),
              "date_start":min(dates,default=None), "date_end":max(dates,default=None)}
    fingerprint = json.dumps([job.digest, plans, result], sort_keys=True, default=str).encode()
    result["revision"] = hashlib.sha256(fingerprint).hexdigest()
    return result
