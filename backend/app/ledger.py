from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.orm import Session

from .calculations import cycle
from .db import lock_owner
from .models import (
    Account,
    Allocation,
    Budget,
    Category,
    Entry,
    Evidence,
    Merchant,
    Reserve,
    ReserveMovement,
    Split,
    Transaction,
    UserSettings,
)
from .schemas import AccountEdit, BudgetIn, CategoryEdit, SettingsIn, TransactionIn


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
    query = (
        select(func.sum(Entry.delta))
        .select_from(Entry)
        .join(Transaction, Transaction.id == Entry.transaction_id)
        .where(
            Entry.owner_id == account.owner_id,
            Transaction.owner_id == account.owner_id,
            Entry.account_id == account.id,
            Transaction.date >= account.opening_date,
        )
    )
    if as_of:
        query = query.where(Transaction.date <= as_of)
    return account.opening_balance + int(db.scalar(query) or 0)


def account_tx_count(db, owner_id, account_id) -> int:
    return int(
        db.scalar(
            select(func.count())
            .select_from(Transaction)
            .where(
                Transaction.owner_id == owner_id,
                or_(Transaction.account_id == account_id, Transaction.to_account_id == account_id),
            )
        )
        or 0
    )


def edit_account(db: Session, owner_id: str, key: str, data: AccountEdit):
    lock_owner(db, owner_id)
    account = owned(db, Account, owner_id, key)
    if data.name is not None:
        account.name = data.name
    if data.code is not None:
        account.code = data.code
    if data.kind is not None:
        account.kind = data.kind
    if data.clear_opening:
        account.opening_date = None
        account.opening_balance = None
    elif data.opening_date is not None and data.opening_balance is not None:
        account.opening_date = data.opening_date
        account.opening_balance = data.opening_balance
    db.flush()
    return account


def delete_account(db: Session, owner_id: str, key: str, transfer_to: str | None = None, cascade: bool = False):
    lock_owner(db, owner_id)
    account = owned(db, Account, owner_id, key)
    affected = db.scalars(
        select(Transaction).where(
            Transaction.owner_id == owner_id,
            or_(Transaction.account_id == key, Transaction.to_account_id == key),
        )
    ).all()

    if affected:
        if transfer_to:
            if transfer_to == key:
                fail("Dompet tujuan pemindahan harus berbeda dari dompet yang dihapus.")
            target = owned(db, Account, owner_id, transfer_to)
            for tx in affected:
                # Handle transfer transactions between deleted account and target account
                if tx.kind == "transfer" and {tx.account_id, tx.to_account_id} == {key, target.id}:
                    db.execute(delete(Entry).where(Entry.transaction_id == tx.id))
                    db.execute(delete(Split).where(Split.transaction_id == tx.id))
                    if tx.fee and tx.fee > 0:
                        tx.kind = "expense"
                        tx.account_id = target.id
                        tx.to_account_id = None
                        tx.amount = tx.fee
                        tx.fee = 0
                        tx.description = tx.description or "Biaya transfer"
                        db.add(Entry(owner_id=owner_id, account_id=target.id, transaction_id=tx.id, delta=-tx.amount))
                        db.add(Split(owner_id=owner_id, transaction_id=tx.id, category_id=None, amount=tx.amount, role="fee"))
                    else:
                        db.execute(update(Evidence).where(Evidence.transaction_id == tx.id).values(transaction_id=None))
                        db.execute(update(Transaction).where(Transaction.original_id == tx.id).values(original_id=None))
                        db.execute(delete(ReserveMovement).where(ReserveMovement.transaction_id == tx.id))
                        db.execute(delete(Reserve).where(Reserve.income_id == tx.id))
                        db.delete(tx)
                else:
                    if tx.account_id == key:
                        tx.account_id = target.id
                    if tx.to_account_id == key:
                        tx.to_account_id = target.id
                    db.execute(
                        update(Entry)
                        .where(Entry.transaction_id == tx.id, Entry.account_id == key)
                        .values(account_id=target.id)
                    )
            db.execute(update(Reserve).where(Reserve.owner_id == owner_id, Reserve.account_id == key).values(account_id=target.id))
        elif cascade:
            for tx in affected:
                _remove_transaction_records(db, owner_id, tx)
            db.execute(delete(Reserve).where(Reserve.owner_id == owner_id, Reserve.account_id == key))
        else:
            raise HTTPException(
                409,
                "Dompet masih memiliki transaksi. Pilih dompet tujuan pemindahan atau hapus beserta seluruh transaksinya.",
            )
    else:
        db.execute(delete(Reserve).where(Reserve.owner_id == owner_id, Reserve.account_id == key))

    db.execute(
        update(UserSettings)
        .where(UserSettings.owner_id == owner_id, UserSettings.default_account_id == key)
        .values(default_account_id=transfer_to if transfer_to else None)
    )
    db.flush()
    db.delete(account)
    db.flush()


def edit_category_item(db: Session, owner_id: str, key: str, data: CategoryEdit):
    lock_owner(db, owner_id)
    obj = owned(db, Category, owner_id, key)
    new_kind = data.kind or obj.kind
    if "parent_id" in data.model_fields_set:
        if data.parent_id:
            if data.parent_id == obj.id:
                fail("Kategori tidak bisa menjadi induk bagi dirinya sendiri.")
            parent = owned(db, Category, owner_id, data.parent_id)
            if parent.kind != new_kind or parent.parent_id or parent.archived:
                fail("Induk harus kategori utama aktif dengan tipe yang sama.")
            has_children = db.scalar(select(Category.id).where(Category.owner_id == owner_id, Category.parent_id == obj.id).limit(1))
            if has_children:
                fail("Kategori ini memiliki subkategori dan harus tetap menjadi kategori utama.")
        obj.parent_id = data.parent_id
    if data.name is not None:
        obj.name = data.name
    if data.kind is not None:
        obj.kind = data.kind
    if data.archived is not None:
        obj.archived = data.archived
    db.flush()
    return obj


def delete_category(db: Session, owner_id: str, key: str, transfer_to: str | None = None):
    lock_owner(db, owner_id)
    cat = owned(db, Category, owner_id, key)
    target_id = None
    if transfer_to:
        if transfer_to == key:
            fail("Kategori pengganti harus berbeda.")
        target = owned(db, Category, owner_id, transfer_to)
        if target.kind != cat.kind:
            fail("Kategori pengganti harus memiliki jenis yang sama.")
        target_id = target.id
    db.execute(
        update(Category)
        .where(Category.owner_id == owner_id, Category.parent_id == key)
        .values(parent_id=target_id if (target_id and not db.get(Category, target_id).parent_id) else None)
    )
    db.execute(
        update(Transaction)
        .where(Transaction.owner_id == owner_id, Transaction.category_id == key)
        .values(category_id=target_id)
    )
    db.execute(
        update(Split)
        .where(Split.owner_id == owner_id, Split.category_id == key)
        .values(category_id=target_id)
    )
    db.execute(delete(ReserveMovement).where(ReserveMovement.owner_id == owner_id, ReserveMovement.category_id == key))
    db.execute(delete(Budget).where(Budget.owner_id == owner_id, Budget.category_id == key))
    db.flush()
    db.delete(cat)
    db.flush()


def splits(db, tx):
    return db.scalars(select(Split).where(Split.transaction_id == tx.id)).all()


def active_reserves(db, owner_id, account_id, day):
    return db.scalars(
        select(Reserve)
        .join(Allocation, Allocation.id == Reserve.application_id)
        .where(
            Reserve.owner_id == owner_id,
            Reserve.account_id == account_id,
            Reserve.remaining > 0,
            Allocation.date <= day,
            (Reserve.expires.is_(None)) | (Reserve.expires > day),
        )
        .order_by(Allocation.date, Reserve.id)
    ).all()


def restore_reserves(db, tx, cat, amount):
    """Restore only the original expense's still-open, same-wallet reservations."""
    original_or_refunds = select(Transaction.id).where(
        (Transaction.id == tx.original_id) | (Transaction.original_id == tx.original_id)
    )
    outstanding = db.execute(
        select(ReserveMovement.reserve_id, func.sum(ReserveMovement.amount))
        .where(ReserveMovement.transaction_id.in_(original_or_refunds), ReserveMovement.category_id == cat)
        .group_by(ReserveMovement.reserve_id)
        .order_by(ReserveMovement.reserve_id)
    ).all()
    for reserve_id, consumed in outstanding:
        reserve = db.get(Reserve, reserve_id)
        if consumed <= 0 or reserve.account_id != tx.account_id or (reserve.expires and reserve.expires <= tx.date):
            continue
        take = min(int(consumed), amount)
        reserve.remaining += take
        db.add(
            ReserveMovement(
                owner_id=tx.owner_id,
                transaction_id=tx.id,
                reserve_id=reserve.id,
                category_id=cat,
                amount=-take,
            )
        )
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


def refund_portions(db, owner_id, data, portions, exclude_tx_id: str | None = None):
    if not data.original_id:
        fail("Pilih transaksi asal untuk pengembalian dana.")
    original = owned(db, Transaction, owner_id, data.original_id)
    if original.kind != "expense" or original.date > data.date:
        fail("Pengembalian harus merujuk ke pengeluaran sebelum atau pada tanggal refund.")
    available = defaultdict(int)
    for part in splits(db, original):
        available[part.category_id] += part.amount
    q = select(Transaction).where(Transaction.original_id == original.id)
    if exclude_tx_id:
        q = q.where(Transaction.id != exclude_tx_id)
    previous = db.scalars(q).all()
    for refund in previous:
        for part in splits(db, refund):
            available[part.category_id] += part.amount
    if not data.splits and data.category_id is None:
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


def _validate_and_prepare_tx(db: Session, owner_id: str, data: TransactionIn, exclude_tx_id: str | None = None):
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
        portions = refund_portions(db, owner_id, data, portions, exclude_tx_id=exclude_tx_id)
    elif data.original_id:
        fail("Transaksi asal hanya untuk refund.")
    else:
        validate_categories(db, owner_id, data.kind, portions)
    return portions


def _write_entries_and_splits(db: Session, owner_id: str, tx: Transaction, data: TransactionIn, portions):
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
                    db.add(
                        ReserveMovement(
                            owner_id=owner_id,
                            transaction_id=tx.id,
                            reserve_id=reserve.id,
                            category_id=cat,
                            amount=take,
                        )
                    )
                    left -= take
                    if not left:
                        break
        elif data.kind == "refund" and cat:
            restore_reserves(db, tx, cat, -amt)


def post_transaction(db: Session, owner_id: str, data: TransactionIn, source="manual", source_ref=None):
    lock_owner(db, owner_id)
    reference = source_ref or data.source_ref or None
    if reference:
        existing = db.scalar(
            select(Transaction).where(
                Transaction.owner_id == owner_id, Transaction.source == source, Transaction.source_ref == reference
            )
        )
        if existing:
            keys = (
                "date",
                "kind",
                "account_id",
                "amount",
                "to_account_id",
                "fee",
                "description",
                "merchant_id",
                "original_id",
                "category_id",
            )
            if any(getattr(data, key) != getattr(existing, key) for key in keys):
                raise HTTPException(409, "Referensi sudah digunakan untuk transaksi berbeda.")
            if data.splits or data.kind in ("income", "expense"):
                expected = sorted((s.category_id or "", s.amount) for s in data.splits) or [
                    (data.category_id or "", data.amount)
                ]
                actual = sorted((s.category_id or "", abs(s.amount)) for s in splits(db, existing))
                if expected != actual:
                    raise HTTPException(409, "Referensi sudah digunakan dengan rincian kategori lain.")
            return existing
    portions = _validate_and_prepare_tx(db, owner_id, data)
    tx = Transaction(
        owner_id=owner_id,
        source=source,
        source_ref=reference,
        **data.model_dump(exclude={"source_ref", "splits"}),
    )
    db.add(tx)
    db.flush()
    _write_entries_and_splits(db, owner_id, tx, data, portions)
    db.flush()
    return tx


def update_transaction(db: Session, owner_id: str, key: str, data: TransactionIn):
    lock_owner(db, owner_id)
    tx = owned(db, Transaction, owner_id, key)
    if data.original_id == tx.id:
        fail("Transaksi tidak dapat merujuk dirinya sendiri.")
    portions = _validate_and_prepare_tx(db, owner_id, data, exclude_tx_id=tx.id)
    db.execute(delete(Entry).where(Entry.transaction_id == tx.id))
    db.execute(delete(Split).where(Split.transaction_id == tx.id))
    db.execute(delete(ReserveMovement).where(ReserveMovement.transaction_id == tx.id))
    for field, value in data.model_dump(exclude={"source_ref", "splits"}).items():
        setattr(tx, field, value)
    db.flush()
    _write_entries_and_splits(db, owner_id, tx, data, portions)
    db.flush()
    return tx


def _remove_transaction_records(db: Session, owner_id: str, tx: Transaction):
    db.execute(update(Evidence).where(Evidence.owner_id == owner_id, Evidence.transaction_id == tx.id).values(transaction_id=None))
    db.execute(update(Transaction).where(Transaction.owner_id == owner_id, Transaction.original_id == tx.id).values(original_id=None))
    db.execute(delete(ReserveMovement).where(ReserveMovement.transaction_id == tx.id))
    db.execute(delete(Reserve).where(Reserve.income_id == tx.id))
    db.execute(delete(Entry).where(Entry.transaction_id == tx.id))
    db.execute(delete(Split).where(Split.transaction_id == tx.id))
    db.delete(tx)


def delete_transaction(db: Session, owner_id: str, key: str):
    lock_owner(db, owner_id)
    tx = owned(db, Transaction, owner_id, key)
    _remove_transaction_records(db, owner_id, tx)
    db.flush()


def transaction_dict(db, tx):
    account = db.get(Account, tx.account_id)
    to_account = db.get(Account, tx.to_account_id) if tx.to_account_id else None
    category = db.get(Category, tx.category_id) if tx.category_id else None
    tx_splits = splits(db, tx)
    split_items = []
    split_names = []
    for s in tx_splits:
        c_obj = db.get(Category, s.category_id) if s.category_id else None
        c_name = "Biaya admin" if s.role == "fee" else (c_obj.name if c_obj else None)
        if s.role != "fee" and c_name and c_name not in split_names:
            split_names.append(c_name)
        split_items.append(
            {
                "category_id": s.category_id,
                "category_name": c_name,
                "amount": s.amount,
                "role": s.role,
            }
        )
    cat_label = category.name if category else (" + ".join(split_names) if split_names else None)
    return {
        **columns(tx),
        "account_name": account.name if account else None,
        "to_account_name": to_account.name if to_account else None,
        "category_name": cat_label,
        "splits": split_items,
    }


def transactions(db, owner_id, start, end):
    if start > end:
        fail("Tanggal awal harus sebelum tanggal akhir.")
    return db.scalars(
        select(Transaction)
        .where(Transaction.owner_id == owner_id, Transaction.date.between(start, end))
        .order_by(Transaction.date.desc(), Transaction.created_at.desc())
    ).all()


def get_settings(db: Session, owner_id: str) -> dict:
    row = db.scalar(select(UserSettings).where(UserSettings.owner_id == owner_id))
    if not row:
        return {"monthly_start_day": 1, "weekly_start_day": 1, "default_account_id": None}
    return {
        "monthly_start_day": row.monthly_start_day,
        "weekly_start_day": row.weekly_start_day,
        "default_account_id": row.default_account_id,
    }


def update_settings(db: Session, owner_id: str, data: SettingsIn) -> dict:
    lock_owner(db, owner_id)
    if data.default_account_id:
        owned(db, Account, owner_id, data.default_account_id)
    row = db.scalar(select(UserSettings).where(UserSettings.owner_id == owner_id))
    if not row:
        row = UserSettings(
            owner_id=owner_id,
            monthly_start_day=data.monthly_start_day,
            weekly_start_day=data.weekly_start_day,
            default_account_id=data.default_account_id,
        )
        db.add(row)
    else:
        row.monthly_start_day = data.monthly_start_day
        row.weekly_start_day = data.weekly_start_day
        row.default_account_id = data.default_account_id
    db.flush()
    return {
        "monthly_start_day": row.monthly_start_day,
        "weekly_start_day": row.weekly_start_day,
        "default_account_id": row.default_account_id,
    }


def list_budgets(db: Session, owner_id: str, start: date, end: date) -> list[dict]:
    cats = {c.id: c for c in rows(db, Category, owner_id)}
    children_map = defaultdict(list)
    for c in cats.values():
        if c.parent_id:
            children_map[c.parent_id].append(c.id)

    spent_by_cat = defaultdict(int)
    parts = db.scalars(
        select(Split)
        .join(Transaction, Transaction.id == Split.transaction_id)
        .where(Transaction.owner_id == owner_id, Transaction.date.between(start, end))
    ).all()
    for part in parts:
        if part.role != "income" and part.category_id:
            spent_by_cat[part.category_id] += part.amount

    budget_rows = db.scalars(select(Budget).where(Budget.owner_id == owner_id)).all()
    result = []
    for b in budget_rows:
        cat = cats.get(b.category_id)
        if not cat:
            continue
        # Include spending in child categories if this budget is set on a parent category
        cat_ids = [b.category_id, *children_map.get(b.category_id, [])]
        spent = max(0, sum(spent_by_cat.get(cid, 0) for cid in cat_ids))
        remaining = b.amount - spent
        percent = round(100 * spent / b.amount) if b.amount > 0 else 0
        status = "over" if spent > b.amount else "warning" if spent >= int(b.amount * 0.8) else "safe"
        result.append(
            {
                "id": b.id,
                "category_id": b.category_id,
                "category_name": cat.name,
                "amount": b.amount,
                "spent": spent,
                "remaining": remaining,
                "percent": percent,
                "status": status,
            }
        )
    return sorted(result, key=lambda x: (-x["percent"], -x["amount"]))


def upsert_budget(db: Session, owner_id: str, data: BudgetIn) -> dict:
    lock_owner(db, owner_id)
    cat = owned(db, Category, owner_id, data.category_id)
    if cat.kind != "expense":
        fail("Anggaran hanya dapat dibuat untuk kategori pengeluaran.")
    row = db.scalar(select(Budget).where(Budget.owner_id == owner_id, Budget.category_id == data.category_id))
    if row:
        row.amount = data.amount
    else:
        row = Budget(owner_id=owner_id, category_id=data.category_id, amount=data.amount)
        db.add(row)
    db.flush()
    return {"id": row.id, "category_id": row.category_id, "category_name": cat.name, "amount": row.amount}


def delete_budget(db: Session, owner_id: str, key: str):
    lock_owner(db, owner_id)
    row = owned(db, Budget, owner_id, key)
    db.delete(row)
    db.flush()


def _period_totals(db: Session, owner_id: str, start: date, end: date) -> dict:
    parts = db.scalars(
        select(Split)
        .join(Transaction, Transaction.id == Split.transaction_id)
        .where(Transaction.owner_id == owner_id, Transaction.date.between(start, end))
    ).all()
    inc = exp = 0
    for s in parts:
        if s.role == "income":
            inc += s.amount
        else:
            exp += s.amount
    return {"start": start, "end": end, "income": inc, "expense": exp, "net": inc - exp}


def summary(db, owner_id, start: date, end: date):
    lock_owner(db, owner_id)
    txs = transactions(db, owner_id, start, end)
    income = expense = 0
    categories = defaultdict(int)
    income_categories = defaultdict(int)
    category_names = {c.id: c.name for c in rows(db, Category, owner_id)}
    accounts = {a.id: a for a in rows(db, Account, owner_id)}
    amounts = defaultdict(list)
    parts = db.scalars(
        select(Split)
        .join(Transaction, Transaction.id == Split.transaction_id)
        .where(Transaction.owner_id == owner_id, Transaction.date.between(start, end))
    )
    for part in parts:
        amounts[part.transaction_id].append(part)
    partial_history = False
    detail = []
    for tx in txs:
        for account_id in (tx.account_id, tx.to_account_id):
            if account_id and account_id in accounts and accounts[account_id].opening_date and tx.date < accounts[account_id].opening_date:
                partial_history = True
        tx_split_items = []
        tx_split_names = []
        for s in amounts[tx.id]:
            c_name = "Biaya admin" if s.role == "fee" else category_names.get(s.category_id)
            if s.role != "fee" and c_name and c_name not in tx_split_names:
                tx_split_names.append(c_name)
            tx_split_items.append(
                {
                    "category_id": s.category_id,
                    "category_name": c_name,
                    "amount": s.amount,
                    "role": s.role,
                }
            )
        cat_label = category_names.get(tx.category_id) or (" + ".join(tx_split_names) if tx_split_names else None)
        detail.append(
            {
                **columns(tx),
                "account_name": accounts[tx.account_id].name if tx.account_id in accounts else None,
                "to_account_name": accounts[tx.to_account_id].name if tx.to_account_id and tx.to_account_id in accounts else None,
                "category_name": cat_label,
                "splits": tx_split_items,
            }
        )
        for s in amounts[tx.id]:
            if s.role == "income":
                income += s.amount
                inc_name = category_names.get(s.category_id, "Pemasukan lainnya")
                income_categories[inc_name] += s.amount
            else:
                expense += s.amount
                name = "Biaya admin" if s.role == "fee" else category_names.get(s.category_id, "Belum dikategorikan")
                categories[name] += s.amount
    jakarta = ZoneInfo("Asia/Jakarta")
    begin = datetime.combine(start, time.min, jakarta) if start > date.min else None
    finish = datetime.combine(end, time.max, jakarta)
    pending = select(func.count()).select_from(Evidence).where(
        Evidence.owner_id == owner_id,
        Evidence.status == "review",
        Evidence.occurred_at <= finish.astimezone(timezone.utc),
    )
    if begin:
        pending = pending.where(Evidence.occurred_at >= begin.astimezone(timezone.utc))
    reviews = db.scalar(pending)

    # Calculate previous comparison period safely (respecting monthly_start_day cycle boundaries)
    span_days = (end - start).days + 1
    prev_summary = None
    if 1 <= span_days <= 370 and start > date(1971, 1, 1):
        prev_end = start - timedelta(days=1)
        start_day = get_settings(db, owner_id).get("monthly_start_day", 1)
        if 25 <= span_days <= 35:
            prev_start, _ = cycle(start_day, prev_end)
        else:
            prev_start = prev_end - timedelta(days=span_days - 1)
        prev_summary = _period_totals(db, owner_id, prev_start, prev_end)

    return {
        "start": start,
        "end": end,
        "income": income,
        "expense": expense,
        "net": income - expense,
        "categories": [{"name": n, "amount": v} for n, v in sorted(categories.items(), key=lambda x: -x[1])],
        "income_categories": [{"name": n, "amount": v} for n, v in sorted(income_categories.items(), key=lambda x: -x[1])],
        "budgets": list_budgets(db, owner_id, start, end),
        "previous": prev_summary,
        "reviews": reviews,
        "partial_history": partial_history,
        "accounts": [{**columns(a), "balance": balance(db, a, end)} for a in accounts.values()],
        "transactions": detail,
    }
