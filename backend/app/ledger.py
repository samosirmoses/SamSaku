from collections import defaultdict
from datetime import date, datetime, time, timezone
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .db import lock_owner
from .models import Account, Allocation, Category, Entry, Evidence, Merchant, Reserve, ReserveMovement, Split, Transaction
from .schemas import TransactionIn


def fail(message):
    raise HTTPException(422, message)


def owned(db, model, owner_id, key):
    row = db.get(model, key)
    if row is None or row.owner_id != owner_id:
        raise HTTPException(404, "Data tidak ditemukan.")
    return row


def rows(db, model, owner_id):
    return db.scalars(select(model).where(model.owner_id == owner_id))


def columns(row):
    return {col.name: getattr(row, col.name) for col in row.__table__.columns if col.name != "owner_id"}


def balance(db, account, as_of=None):
    if account.opening_date is None or (as_of and as_of < account.opening_date):
        return None
    query = select(func.sum(Entry.delta)).select_from(Entry).join(
        Transaction, Transaction.id == Entry.transaction_id).where(
            Entry.owner_id == account.owner_id, Transaction.owner_id == account.owner_id,
            Entry.account_id == account.id, Transaction.date >= account.opening_date)
    if as_of:
        query = query.where(Transaction.date <= as_of)
    # PostgreSQL returns NUMERIC for SUM(BIGINT); amounts in IDR remain whole.
    return account.opening_balance + int(db.scalar(query) or 0)


def splits(db, tx):
    return db.scalars(select(Split).where(Split.transaction_id == tx.id)).all()


def active_reserves(db, owner_id, account_id, day):
    return db.scalars(select(Reserve).join(Allocation, Allocation.id == Reserve.application_id)
        .where(Reserve.owner_id == owner_id, Reserve.account_id == account_id, Reserve.remaining > 0,
               Allocation.date <= day, (Reserve.expires.is_(None)) | (Reserve.expires > day))
        .order_by(Allocation.date, Reserve.id)).all()


def restore_reserves(db, tx, cat, amount):
    """Restore only the original expense's still-open, same-wallet reservations."""
    original_or_refunds = select(Transaction.id).where(
        (Transaction.id == tx.original_id) | (Transaction.original_id == tx.original_id))
    outstanding = db.execute(select(ReserveMovement.reserve_id, func.sum(ReserveMovement.amount))
        .where(ReserveMovement.transaction_id.in_(original_or_refunds), ReserveMovement.category_id == cat)
        .group_by(ReserveMovement.reserve_id).order_by(ReserveMovement.reserve_id)).all()
    for reserve_id, consumed in outstanding:
        reserve = db.get(Reserve, reserve_id)
        if consumed <= 0 or reserve.account_id != tx.account_id or (reserve.expires and reserve.expires <= tx.date):
            continue
        take = min(int(consumed), amount)
        reserve.remaining += take
        db.add(ReserveMovement(owner_id=tx.owner_id, transaction_id=tx.id, reserve_id=reserve.id,
                               category_id=cat, amount=-take))
        amount -= take
        if not amount:
            break


def validate_categories(db, owner_id, kind, portions):
    for cat_id, _ in portions:
        if cat_id is None:
            continue
        category = owned(db, Category, owner_id, cat_id)
        wanted = "income" if kind == "income" else "expense"
        if category.kind != wanted or category.archived:
            fail("Pilih kategori aktif dengan tipe yang sesuai.")


def refund_portions(db, owner_id, data, portions):
    if not data.original_id:
        fail("Pilih transaksi asal untuk pengembalian dana.")
    original = owned(db, Transaction, owner_id, data.original_id)
    if original.kind != "expense" or original.date > data.date:
        fail("Pengembalian harus merujuk ke pengeluaran sebelum atau pada tanggal refund.")
    available = defaultdict(int)
    for part in splits(db, original):
        available[part.category_id] += part.amount
    previous = db.scalars(select(Transaction).where(Transaction.original_id == original.id)).all()
    for refund in previous:
        for part in splits(db, refund):
            available[part.category_id] += part.amount
    if not data.splits and data.category_id is None:
        # Stable partial-refund distribution preserves the original category caps.
        portions = []
        left = data.amount
        for cat_id, limit in sorted(available.items(), key=lambda item: item[0] or ""):
            take = min(limit, left)
            if take > 0:
                portions.append((cat_id, take))
                left -= take
        if left:
            fail("Refund melebihi bagian transaksi yang belum dikembalikan.")
    requested = defaultdict(int)
    for cat_id, amount in portions:
        requested[cat_id] += amount
    if any(amount > available[cat_id] for cat_id, amount in requested.items()):
        fail("Nilai refund melebihi pengeluaran kategori asal.")
    return portions


def post_transaction(db: Session, owner_id: str, data: TransactionIn, source="manual", source_ref=None):
    lock_owner(db, owner_id)
    reference = source_ref or data.source_ref or None
    if reference:
        existing = db.scalar(select(Transaction).where(Transaction.owner_id == owner_id,
            Transaction.source == source, Transaction.source_ref == reference))
        if existing:
            keys = ("date", "kind", "account_id", "amount", "to_account_id", "fee", "description",
                    "merchant_id", "original_id", "category_id")
            if any(getattr(data, key) != getattr(existing, key) for key in keys):
                raise HTTPException(409, "Referensi sudah digunakan untuk transaksi berbeda.")
            if data.splits or data.kind in ("income", "expense"):
                expected = sorted((s.category_id or "", s.amount) for s in data.splits) or [(data.category_id or "", data.amount)]
                actual = sorted((s.category_id or "", abs(s.amount)) for s in splits(db, existing))
                if expected != actual:
                    raise HTTPException(409, "Referensi sudah digunakan dengan rincian kategori lain.")
            return existing
    owned(db, Account, owner_id, data.account_id)
    if data.merchant_id:
        owned(db, Merchant, owner_id, data.merchant_id)
    portions = [(p.category_id, p.amount) for p in data.splits] or [(data.category_id, data.amount)]
    if data.splits and (sum(p.amount for p in data.splits) != data.amount or data.category_id):
        fail("Jumlah rincian kategori harus sama dengan total transaksi. Pilih kategori pada rinciannya.")
    if data.kind == "transfer":
        if not data.to_account_id or data.account_id == data.to_account_id or data.splits or data.category_id:
            fail("Pilih dua dompet berbeda untuk transfer.")
        owned(db, Account, owner_id, data.to_account_id)
    elif data.to_account_id or data.fee:
        fail("Dompet tujuan dan biaya transfer hanya untuk transfer.")
    if data.kind == "refund":
        portions = refund_portions(db, owner_id, data, portions)
    elif data.original_id:
        fail("Transaksi asal hanya untuk refund.")
    else:
        validate_categories(db, owner_id, data.kind, portions)

    tx = Transaction(owner_id=owner_id, source=source, source_ref=reference,
                     **data.model_dump(exclude={"source_ref", "splits"}))
    db.add(tx)
    db.flush()
    if data.kind == "transfer":
        movements = [(data.account_id, -data.amount - data.fee), (data.to_account_id, data.amount)]
        report_parts = [(None, data.fee, "fee")] if data.fee else []
    else:
        direction = -1 if data.kind == "expense" else 1
        movements = [(data.account_id, direction * data.amount)]
        role = "income" if data.kind == "income" else "expense"
        report_parts = [(cat, -amt if data.kind == "refund" else amt, role) for cat, amt in portions]
    for account_id, delta in movements:
        db.add(Entry(owner_id=owner_id, account_id=account_id, transaction_id=tx.id, delta=delta))
    for cat, amt, role in report_parts:
        db.add(Split(owner_id=owner_id, transaction_id=tx.id, category_id=cat, amount=amt, role=role))
        if data.kind == "expense" and cat:
            left = amt
            for reserve in active_reserves(db, owner_id, tx.account_id, tx.date):
                if cat in reserve.category_ids:
                    take = min(reserve.remaining, left)
                    reserve.remaining -= take
                    db.add(ReserveMovement(owner_id=owner_id, transaction_id=tx.id, reserve_id=reserve.id,
                                           category_id=cat, amount=take))
                    left -= take
                    if not left:
                        break
        elif data.kind == "refund" and cat:
            restore_reserves(db, tx, cat, -amt)
    db.flush()
    return tx


def transaction_dict(db, tx):
    account = db.get(Account, tx.account_id)
    category = db.get(Category, tx.category_id) if tx.category_id else None
    return {**columns(tx), "account_name": account.name, "category_name": category.name if category else None,
            "splits": [{"category_id": s.category_id, "amount": s.amount, "role": s.role} for s in splits(db, tx)]}


def transactions(db, owner_id, start, end):
    if start > end:
        fail("Tanggal awal harus sebelum tanggal akhir.")
    return db.scalars(select(Transaction).where(Transaction.owner_id == owner_id,
        Transaction.date.between(start, end)).order_by(Transaction.date.desc(), Transaction.created_at.desc())).all()


def summary(db, owner_id, start: date, end: date):
    lock_owner(db, owner_id)
    txs = transactions(db, owner_id, start, end)
    income = expense = 0
    categories = defaultdict(int)
    category_names = {c.id: c.name for c in rows(db, Category, owner_id)}
    accounts = {a.id: a for a in rows(db, Account, owner_id)}
    amounts = defaultdict(list)
    parts = db.scalars(select(Split).join(Transaction, Transaction.id == Split.transaction_id).where(
        Transaction.owner_id == owner_id, Transaction.date.between(start, end)))
    for part in parts:
        amounts[part.transaction_id].append(part)
    partial_history = False
    detail = []
    for tx in txs:
        for account_id in (tx.account_id, tx.to_account_id):
            if account_id and accounts[account_id].opening_date and tx.date < accounts[account_id].opening_date:
                partial_history = True
        detail.append({**columns(tx), "account_name": accounts[tx.account_id].name,
                       "category_name": category_names.get(tx.category_id),
                       "splits": [{"category_id": s.category_id, "amount": s.amount, "role": s.role}
                                 for s in amounts[tx.id]]})
        for s in amounts[tx.id]:
            if s.role == "income":
                income += s.amount
            else:
                expense += s.amount
                name = "Biaya admin" if s.role == "fee" else category_names.get(s.category_id, "Belum dikategorikan")
                categories[name] += s.amount
    jakarta = ZoneInfo("Asia/Jakarta")
    begin = datetime.combine(start, time.min, jakarta) if start > date.min else None
    finish = datetime.combine(end, time.max, jakarta)
    pending = select(func.count()).select_from(Evidence).where(Evidence.owner_id == owner_id, Evidence.status == "review",
                                                                 Evidence.occurred_at <= finish.astimezone(timezone.utc))
    if begin:
        pending = pending.where(Evidence.occurred_at >= begin.astimezone(timezone.utc))
    reviews = db.scalar(pending)
    return {"start": start, "end": end, "income": income, "expense": expense, "net": income-expense,
            "categories": [{"name": n, "amount": v} for n, v in sorted(categories.items(), key=lambda x: -x[1])],
            "reviews": reviews, "partial_history": partial_history,
            "accounts": [{**columns(a), "balance": balance(db, a, end)} for a in accounts.values()],
            "transactions": detail}
