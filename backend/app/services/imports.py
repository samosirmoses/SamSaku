"""Map and validate Excel rows without mutating the ledger during preview."""
import hashlib
import json
from collections import Counter
from datetime import date
from uuid import NAMESPACE_URL, uuid5

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import models
from ..core.db import lock_owner
from ..schemas import Commit, Preview, SchemeIn, TransactionIn
from .accounts import balance
from .jobs import FileJob, ImportEntry, get_job, load_file, load_remote_file, purge_file, purge_remote_file
from .planning import validate_scheme
from .transactions import post_transaction
from .xlsx import KINDS, WorkbookError, as_date, inspect, money, norm, scan, template

TABLES = {
    "accounts": models.Account,
    "categories": models.Category,
    "merchants": models.Merchant,
    "aliases": models.Alias,
    "schemes": models.Scheme,
}


def lookup(db: Session, owner: str, table: str, value, kind: str | None = None):
    if not str(value or "").strip():
        return None
    model = TABLES[table]
    stmt = select(model).where(model.owner_id == owner)
    if kind:
        stmt = stmt.where(model.kind == kind)
    keys = ["id", "code", "name"] if hasattr(model, "code") else ["id", "name"]
    target = norm(value)
    for field in keys:
        matches = list(db.scalars(stmt.where(func.lower(getattr(model, field)) == target).limit(2)))
        if len(matches) > 1:
            raise ValueError(f"Nama '{value}' ambigu. Gunakan kode.")
        if matches:
            return matches[0]
    return None


def need(db: Session, owner: str, table: str, value, kind: str | None = None):
    record = lookup(db, owner, table, value, kind)
    if not record:
        raise ValueError(f"Referensi {table} '{value or ''}' belum tersedia.")
    return record


def master(db: Session, owner: str, entity: str, v: dict, order: str):
    def required(key: str) -> str:
        text = str(v.get(key, "")).strip()
        if not text or len(text) > 120:
            raise ValueError(f"{key}: isi 1–120 karakter.")
        return text

    if entity == "pots":
        scheme = need(db, owner, "schemes", required("scheme"))
        name, mode = required("name"), norm(required("mode"))
        mode = {"tetap": "fixed", "persen": "percent", "sisa": "remainder"}.get(mode, mode)
        value = money(v.get("value", 0))
        if mode not in ("fixed", "percent", "remainder") or (mode == "percent" and value > 100):
            raise ValueError("Aturan pos tidak valid.")
        rules = list(scheme.rules or [])
        existing = next((r for r in rules if norm(r["name"]) == norm(name)), {})
        rule = {**existing, "name": name, "mode": mode, "value": value, "category_ids": existing.get("category_ids", [])}
        if v.get("category"):
            rule["category_ids"] = [need(db, owner, "categories", v["category"], "expense").id]
        rules = [r for r in rules if norm(r["name"]) != norm(name)] + [rule]
        validate_scheme(db, owner, SchemeIn(name=scheme.name, cycle_day=scheme.cycle_day, rules=rules))
        if existing != rule:
            scheme.rules = rules
        return scheme, ("duplicate" if existing == rule else "update" if existing else "new"), {}

    model = TABLES[entity]
    key = "name" if entity == "aliases" else "code"
    code = required(key)
    if key == "code" and len(code) > 80:
        raise ValueError("Kode maksimal 80 karakter.")
    obj = db.scalar(select(model).where(model.owner_id == owner, func.lower(getattr(model, key)) == norm(code)))
    values: dict = {}
    if v.get("name") or not obj:
        values["name"] = required("name")
    if entity in ("accounts", "categories") and (v.get("kind") or not obj):
        values["kind"] = KINDS.get(norm(v.get("kind")), norm(v.get("kind")))
        allowed = (
            ("income", "expense")
            if entity == "categories"
            else ("bank", "cash", "ewallet", "wallet", "investment", "liability", "e-wallet")
        )
        if values["kind"] not in allowed:
            raise ValueError("Jenis kategori/dompet tidak dikenali.")
        if obj and values["kind"] != obj.kind:
            raise ValueError("Perubahan jenis master harus ditinjau melalui pengaturan.")
    if entity == "accounts":
        if ("opening_balance" in v) != ("opening_date" in v):
            raise ValueError("Tanggal dan nominal saldo awal harus diisi bersama.")
        if "opening_date" in v:
            values.update(
                opening_date=date.fromisoformat(as_date(v["opening_date"], order)),
                opening_balance=money(v["opening_balance"], signed=True),
            )
    if entity == "categories" and v.get("parent"):
        parent = need(db, owner, entity, v["parent"], values.get("kind") or obj.kind)
        if parent.parent_id or (obj and obj.id == parent.id):
            raise ValueError("Kategori mendukung maksimal dua tingkat.")
        if obj and db.scalar(
            select(models.Category.id)
            .where(models.Category.owner_id == owner, models.Category.parent_id == obj.id)
            .limit(1)
        ):
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
    changes = {k: {"from": str(getattr(obj, k)), "to": str(val)} for k, val in values.items() if getattr(obj, k) != val}
    for k, val in values.items():
        setattr(obj, k, val)
    db.flush()
    return obj, "update" if changes else "duplicate", changes


def transaction(db: Session, owner: str, job, row: dict, seen_fingerprints: Counter | None = None):
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
                category, _, _ = master(db, owner, "categories", {"code": code, "name": label, "kind": wanted}, row["order"])
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

    def origin_ref(ref_str: str) -> str:
        return f"{account.id}/{ref_str}"

    txs = select(models.Transaction).where(models.Transaction.owner_id == owner)
    original_id = None
    if kind == "refund":
        orig_ref = str(v.get("original_ref") or "").strip()
        original = None
        if orig_ref:
            original = db.scalar(
                txs.where(models.Transaction.source == "excel", models.Transaction.source_ref == origin_ref(orig_ref))
            )
            if not original:
                cross_matches = [
                    cand
                    for cand in db.scalars(
                        txs.where(
                            models.Transaction.source == "excel",
                            models.Transaction.kind == "expense",
                            models.Transaction.source_ref.like(f"%/{orig_ref}"),
                        )
                    ).all()
                    if cand.source_ref and cand.source_ref.endswith("/" + orig_ref)
                ]
                if len(cross_matches) > 1:
                    raise ValueError("Referensi asal ditemukan di lebih dari satu dompet. Gunakan ID transaksi.")
                if len(cross_matches) == 1:
                    original = cross_matches[0]
            if not original:
                prov_matches = db.scalars(
                    txs.where(
                        models.Transaction.source.in_(["bca", "gopay", "telegram", "manual", "receipt"]),
                        models.Transaction.kind == "expense",
                        models.Transaction.source_ref == orig_ref,
                    ).limit(2)
                ).all()
                if len(prov_matches) == 1:
                    original = prov_matches[0]
            if not original:
                original = db.scalar(txs.where(models.Transaction.id == orig_ref))
        if not original:
            raise ValueError("Refund memerlukan ID transaksi asal atau referensi pembayaran yang sudah diimpor.")
        original_id = original.id

    if v.get("reference"):
        ref = origin_ref(v["reference"])
    else:
        fp_counter = seen_fingerprints if seen_fingerprints is not None else Counter()
        fp_json = json.dumps(
            [
                day.isoformat(),
                kind,
                account.id,
                destination.id if destination else None,
                amount,
                fee,
                description,
                category.id if category else None,
                merchant.id if merchant else None,
                original_id,
            ],
            separators=(",", ":"),
        )
        occ = fp_counter[fp_json]
        fp_counter[fp_json] = occ + 1
        ref = f"row/{hashlib.sha256(fp_json.encode('utf-8')).hexdigest()[:32]}/{occ}"
    if len(ref) > 500:
        raise ValueError("Referensi terlalu panjang.")
    payload = TransactionIn(
        kind=kind,
        date=day,
        account_id=account.id,
        amount=amount,
        category_id=category.id if category else None,
        description=description,
        to_account_id=destination.id if destination else None,
        fee=fee,
        original_id=original_id,
        merchant_id=merchant.id if merchant else None,
    )
    existing = db.scalar(txs.where(models.Transaction.source == "excel", models.Transaction.source_ref == ref))
    if existing:
        keys = ("kind", "account_id", "date", "amount", "to_account_id", "fee", "description", "category_id", "merchant_id", "original_id")
        if any(getattr(existing, key) != getattr(payload, key) for key in keys):
            raise ValueError("Referensi sudah ada dengan nilai lain. Periksa transaksi asal.")
        return existing, "duplicate", {}, {}
    if v.get("reference"):
        provider = db.scalars(
            txs.where(
                models.Transaction.source.in_(["bca", "gopay"]),
                models.Transaction.account_id == account.id,
                models.Transaction.source_ref == str(v["reference"]),
            )
        ).all()
        if provider:
            if len(provider) != 1 or (provider[0].kind, provider[0].amount, provider[0].date) != (kind, amount, day):
                raise ValueError("Referensi bukti digital bertentangan dengan rincian baris ini.")
            return provider[0], "duplicate", {}, {}
    similar = db.scalar(
        txs.where(
            models.Transaction.date == day,
            models.Transaction.account_id == account.id,
            models.Transaction.amount == amount,
            models.Transaction.kind == kind,
        ).limit(1)
    )
    tx = post_transaction(db, owner, payload, source="excel", source_ref=ref)
    impact = {}
    if account.opening_date is not None and day >= account.opening_date:
        impact[account.code] = amount if kind in ("income", "refund") else -amount - fee
    if destination and destination.opening_date is not None and day >= destination.opening_date:
        impact[destination.code] = amount
    report = {
        "income": amount if kind == "income" else 0,
        "expense": amount if kind == "expense" else -amount if kind == "refund" else fee if kind == "transfer" else 0,
    }
    return tx, "similar" if similar else "new", impact, report


def evaluate(
    db: Session,
    owner: str,
    job,
    plans: list[dict],
    *,
    apply: bool = False,
    excluded=(),
    accepted=(),
    preloaded_rows: list[dict] | None = None,
) -> dict:
    """Master references and ledger rules run against real transactional state."""
    from pydantic import ValidationError
    from sqlalchemy.exc import IntegrityError

    rows_data = preloaded_rows if preloaded_rows is not None else scan(load_file(job), plans)
    results, impacts, totals = [], Counter(), Counter()
    seen_fingerprints: Counter = Counter()
    dates = []
    batch = db.begin_nested()
    try:
        for row in rows_data:
            key = (row["sheet"], row["row"])
            item = {k: row[k] for k in ("sheet", "row", "entity", "values")}
            item.update(status="excluded", message="")
            if key not in excluded:
                try:
                    with db.begin_nested():
                        if row["entity"] == "transactions":
                            obj, status, impact, report = transaction(db, owner, job, row, seen_fingerprints)
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
                            obj, status, changes = master(db, owner, row["entity"], row["values"], row["order"])
                            if row["entity"] == "accounts" and status != "duplicate" and obj.opening_date:
                                impacts[obj.code] += balance(db, obj) - (old_balance or 0)
                            item["changes"] = changes
                        item["status"] = status
                        if apply:
                            db.add(
                                ImportEntry(
                                    owner_id=owner,
                                    job_id=job.id,
                                    sheet=key[0],
                                    row=key[1],
                                    entity=row["entity"],
                                    record_id=obj.id,
                                )
                            )
                            db.flush()
                except (ValueError, HTTPException, IntegrityError, ValidationError) as err:
                    message = (
                        err.detail
                        if isinstance(err, HTTPException)
                        else "Baris bertentangan dengan data yang ada."
                        if isinstance(err, IntegrityError)
                        else str(err)
                    )
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
    result = {
        "rows": results,
        "counts": dict(Counter(r["status"] for r in results)),
        "income": totals["income"],
        "expense": totals["expense"],
        "impacts": dict(impacts),
        "date_start": min(dates, default=None),
        "date_end": max(dates, default=None),
    }
    fingerprint = json.dumps([job.digest, plans, result], sort_keys=True, default=str).encode()
    result["revision"] = hashlib.sha256(fingerprint).hexdigest()
    return result


def import_job(db: Session, user: str, job_id: str, lock: bool = False) -> FileJob:
    job = get_job(db, user, job_id, lock=lock)
    if job.kind not in ("transactions", "masters"):
        raise HTTPException(404, "Impor tidak ditemukan.")
    return job


def list_import_history(db: Session, user: str) -> list[dict]:
    query = (
        select(FileJob.id, FileJob.filename, FileJob.kind, FileJob.status, FileJob.created_at)
        .where(FileJob.owner_id == user, FileJob.kind.in_(["transactions", "masters"]))
        .order_by(FileJob.created_at.desc())
        .limit(100)
    )
    return [dict(row) for row in db.execute(query).mappings()]


def list_import_mappings(db: Session, user: str) -> list[dict]:
    recent = db.execute(
        select(FileJob.config)
        .where(FileJob.owner_id == user, FileJob.config.is_not(None))
        .order_by(FileJob.created_at.desc())
        .limit(200)
    )
    seen = {}
    for (config,) in recent:
        if config.get("mapping_name"):
            seen.setdefault(
                config["mapping_name"],
                {"mapping_name": config["mapping_name"], "sheets": config["sheets"]},
            )
    return list(seen.values())


def get_import_status(db: Session, user: str, job_id: str) -> dict:
    job = import_job(db, user, job_id)
    return {"id": job.id, "status": job.status, "config": job.config, "result": job.result}


def import_errors_rows(db: Session, user: str, job_id: str) -> list[list]:
    job = import_job(db, user, job_id)
    out = [["Sheet", "Baris", "Status", "Alasan"]]
    out.extend(
        [r["sheet"], r["row"], r["status"], r["message"]]
        for r in (job.result or {}).get("rows", [])
        if r["status"] in ("error", "similar")
    )
    return out


def preview_import(db: Session, user: str, job_id: str, body: Preview) -> dict:
    lock_owner(db, user)
    job = import_job(db, user, job_id, True)
    if job.status in ("done", "approved"):
        raise HTTPException(409, "Batch ini sudah disetujui.")
    plans = [s.model_dump() for s in body.sheets]
    if len({p["name"] for p in plans}) != len(plans):
        raise HTTPException(422, "Setiap sheet hanya boleh dipilih sekali.")
    if any((p["entity"] == "transactions") != (job.kind == "transactions") for p in plans):
        raise HTTPException(422, "Jenis sheet harus sesuai dengan jenis impor.")
    result = evaluate(db, user, job, plans)
    job.config = body.model_dump()
    job.result = result
    job.status = "preview"
    db.commit()
    return result


def _approval_key(approval: Commit | dict) -> tuple[str, list[tuple[str, int]], list[tuple[str, int]]]:
    data = approval.model_dump() if isinstance(approval, Commit) else (approval or {})
    exclude = sorted({(r["sheet"], r["row"]) for r in data.get("exclude") or []})
    accept_similar = sorted({(r["sheet"], r["row"]) for r in data.get("accept_similar") or []})
    return str(data.get("revision") or ""), exclude, accept_similar


def _execute_import_commit(
    db: Session,
    user: str,
    job: FileJob,
    approval: Commit,
    plans: list[dict],
    raw_bytes: bytes | None = None,
) -> dict:
    file_bytes = raw_bytes if raw_bytes is not None else load_file(job)
    parsed_rows = scan(file_bytes, plans)
    if evaluate(db, user, job, plans, preloaded_rows=parsed_rows)["revision"] != approval.revision:
        raise HTTPException(409, "Data berubah sejak ditinjau. Segarkan pratinjau.")
    result = evaluate(
        db,
        user,
        job,
        plans,
        apply=True,
        excluded={(r.sheet, r.row) for r in approval.exclude},
        accepted={(r.sheet, r.row) for r in approval.accept_similar},
        preloaded_rows=parsed_rows,
    )
    counts = result["counts"]
    return {
        "status": "done",
        "id": job.id,
        "counts": counts,
        "applied": sum(counts.get(k, 0) for k in ("new", "similar", "update")),
        "skipped": counts.get("duplicate", 0) + counts.get("excluded", 0),
    }


def _cleanup_job_storage(db: Session, user: str, job_id: str, purge_key: str | None) -> None:
    if not purge_key:
        return
    try:
        purge_remote_file(purge_key)
        lock_owner(db, user)
        purged = db.get(FileJob, job_id)
        if purged and purged.owner_id == user:
            purged.object_key = None
        db.commit()
    except Exception:
        db.rollback()


def commit_import(db: Session, user: str, job_id: str, body: Commit) -> tuple[dict, bool]:
    lock_owner(db, user)
    job = import_job(db, user, job_id, True)
    if job.status == "done":
        saved_approval = (job.config or {}).get("approval")
        if saved_approval is not None and _approval_key(body) != _approval_key(saved_approval):
            raise HTTPException(409, "Batch impor sudah selesai dengan persetujuan berbeda.")
        return job.result, False
    if job.status == "approved":
        saved_approval = (job.config or {}).get("approval")
        if saved_approval is not None and _approval_key(body) != _approval_key(saved_approval):
            raise HTTPException(409, "Batch impor sudah disetujui dengan konfigurasi berbeda.")
        return publish_approved(db, user, job_id), True
    if job.status != "preview" or job.result.get("revision") != body.revision:
        raise HTTPException(409, "Buat pratinjau terbaru sebelum menyimpan.")
    excluded = {(r.sheet, r.row) for r in body.exclude}
    accepted = {(r.sheet, r.row) for r in body.accept_similar}
    for row in job.result["rows"]:
        key = (row["sheet"], row["row"])
        if key not in excluded and (row["status"] == "error" or (row["status"] == "similar" and key not in accepted)):
            raise HTTPException(409, "Selesaikan baris yang perlu ditinjau.")

    raw_bytes = job.data
    object_key = job.object_key
    expires_at = job.expires_at
    if raw_bytes is None:
        if expires_at < models.job_now():
            db.rollback()
            raise HTTPException(410, "File sementara kedaluwarsa. Unggah kembali.")
        if not object_key:
            db.rollback()
            raise HTTPException(410, "File sementara sudah dihapus.")
        db.rollback()
        raw_bytes = load_remote_file(object_key)
        lock_owner(db, user)
        job = import_job(db, user, job_id, True)
        if job.status == "done":
            saved_approval = (job.config or {}).get("approval")
            if saved_approval is not None and _approval_key(body) != _approval_key(saved_approval):
                raise HTTPException(409, "Batch impor sudah selesai dengan persetujuan berbeda.")
            return job.result, False
        if job.status != "preview" or job.result.get("revision") != body.revision:
            raise HTTPException(409, "Buat pratinjau terbaru sebelum menyimpan.")

    plans = job.config["sheets"]
    try:
        final = _execute_import_commit(db, user, job, body, plans, raw_bytes=raw_bytes)
        job.config = {**job.config, "approval": body.model_dump()}
        job.result = final
        job.status = "done"
        purge_key = job.object_key
        job.data = None
        db.commit()
    except Exception:
        db.rollback()
        raise

    _cleanup_job_storage(db, user, job_id, purge_key)
    return final, True


def publish_approved(db: Session, user: str, job_id: str) -> dict:
    lock_owner(db, user)
    job = import_job(db, user, job_id, True)
    if job.status == "done":
        return job.result
    if job.status != "approved":
        raise HTTPException(409, "Impor memerlukan persetujuan.")
    approval = Commit.model_validate(job.config["approval"])
    plans = job.config["sheets"]
    try:
        final = _execute_import_commit(db, user, job, approval, plans)
        job.result = final
        job.status = "done"
        purge_key = job.object_key
        job.data = None
        db.commit()
    except (HTTPException, WorkbookError):
        db.rollback()
        lock_owner(db, user)
        reverted = import_job(db, user, job_id, True)
        if reverted.status == "approved":
            reverted.status = "preview"
            reverted.config = {k: v for k, v in reverted.config.items() if k != "approval"}
            db.commit()
        raise
    except Exception:
        db.rollback()
        raise

    _cleanup_job_storage(db, user, job_id, purge_key)
    return final


__all__ = [
    "commit_import",
    "evaluate",
    "get_import_status",
    "import_errors_rows",
    "import_job",
    "inspect",
    "list_import_history",
    "list_import_mappings",
    "lookup",
    "master",
    "need",
    "preview_import",
    "publish_approved",
    "scan",
    "template",
    "transaction",
]
