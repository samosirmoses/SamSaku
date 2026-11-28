"""Transaction posting, double-entry ledger updates, refund validation, and batch serialization."""
from collections import defaultdict
from datetime import date

from fastapi import HTTPException
from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from ..core.db import lock_owner
from ..models import Account, Allocation, Category, Entry, Evidence, Merchant, Reserve, ReserveMovement, Split, Transaction
from ..schemas import TransactionIn
from .accounts import active_reserves
from .common import columns, fail, owned, rows


def splits(db: Session, tx: Transaction) -> list[Split]:
    return list(db.scalars(select(Split).where(Split.owner_id == tx.owner_id, Split.transaction_id == tx.id)).all())


def _reverse_reserve_movements(db: Session, owner_id: str, tx_id: str) -> None:
    """Reverse reserve consumption/restoration recorded for a transaction before deleting movements."""
    movements = list(
        db.scalars(
            select(ReserveMovement).where(
                ReserveMovement.owner_id == owner_id,
                ReserveMovement.transaction_id == tx_id,
            )
        ).all()
    )
    if not movements:
        return
    for mv in movements:
        reserve = db.get(Reserve, mv.reserve_id)
        if reserve and reserve.owner_id == owner_id:
            reserve.remaining = max(0, min(reserve.amount, reserve.remaining + mv.amount))
    db.execute(
        delete(ReserveMovement).where(
            ReserveMovement.owner_id == owner_id,
            ReserveMovement.transaction_id == tx_id,
        )
    )


def restore_reserves(db: Session, tx: Transaction, cat: str, amount: int) -> None:
    """Restore only the original expense's still-open, same-wallet reservations."""
    original_or_refunds = select(Transaction.id).where(
        Transaction.owner_id == tx.owner_id,
        (Transaction.id == tx.original_id) | (Transaction.original_id == tx.original_id),
    )
    outstanding = db.execute(
        select(ReserveMovement.reserve_id, func.sum(ReserveMovement.amount))
        .where(
            ReserveMovement.owner_id == tx.owner_id,
            ReserveMovement.transaction_id.in_(original_or_refunds),
            ReserveMovement.category_id == cat,
        )
        .group_by(ReserveMovement.reserve_id)
        .order_by(ReserveMovement.reserve_id)
    ).all()
    for reserve_id, consumed in outstanding:
        reserve = db.get(Reserve, reserve_id)
        if (
            not reserve
            or reserve.owner_id != tx.owner_id
            or consumed <= 0
            or reserve.account_id != tx.account_id
            or (reserve.expires and reserve.expires <= tx.date)
        ):
            continue
        take = min(int(consumed), amount, max(0, reserve.amount - reserve.remaining))
        if take <= 0:
            continue
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


def validate_categories(db: Session, owner_id: str, kind: str, portions: list[tuple[str | None, int]]) -> None:
    for cat_id, _ in portions:
        if cat_id is None:
            continue
        category = owned(db, Category, owner_id, cat_id)
        wanted = "income" if kind == "income" else "expense"
        if category.kind != wanted or category.archived:
            fail("Pilih kategori aktif dengan tipe yang sesuai.")


def refund_portions(
    db: Session,
    owner_id: str,
    data: TransactionIn,
    portions: list[tuple[str | None, int]],
    exclude_tx_id: str | None = None,
) -> list[tuple[str | None, int]]:
    if not data.original_id:
        fail("Pilih transaksi asal untuk pengembalian dana.")
    original = owned(db, Transaction, owner_id, data.original_id)
    if original.kind != "expense" or original.date > data.date:
        fail("Pengembalian harus merujuk ke pengeluaran sebelum atau pada tanggal refund.")

    tx_ids_q = select(Transaction.id).where(
        Transaction.owner_id == owner_id,
        (Transaction.id == original.id) | (Transaction.original_id == original.id),
    )
    if exclude_tx_id:
        tx_ids_q = tx_ids_q.where(Transaction.id != exclude_tx_id)
    tx_ids = list(db.scalars(tx_ids_q).all())

    available: dict[str | None, int] = defaultdict(int)
    if tx_ids:
        for cat_id, total in db.execute(
            select(Split.category_id, func.sum(Split.amount))
            .where(Split.owner_id == owner_id, Split.transaction_id.in_(tx_ids))
            .group_by(Split.category_id)
        ).all():
            available[cat_id] += int(total or 0)

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
    requested: dict[str | None, int] = defaultdict(int)
    for cat_id, amount in portions:
        requested[cat_id] += amount
    if any(amount > available[cat_id] for cat_id, amount in requested.items()):
        fail("Nilai refund melebihi pengeluaran kategori asal.")
    return portions


def _validate_and_prepare_tx(
    db: Session,
    owner_id: str,
    data: TransactionIn,
    exclude_tx_id: str | None = None,
) -> list[tuple[str | None, int]]:
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


def _write_entries_and_splits(
    db: Session,
    owner_id: str,
    tx: Transaction,
    data: TransactionIn,
    portions: list[tuple[str | None, int]],
) -> None:
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


def transaction_matches_input(db: Session, owner_id: str, existing: Transaction, data: TransactionIn) -> bool:
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
        return False
    actual = sorted((s.category_id or "", abs(s.amount)) for s in splits(db, existing))
    if data.splits or data.kind in ("income", "expense"):
        expected = sorted((s.category_id or "", s.amount) for s in data.splits) or [
            (data.category_id or "", data.amount)
        ]
        return expected == actual
    if data.kind == "refund":
        if data.category_id is not None:
            return [(data.category_id, data.amount)] == actual
        try:
            computed = refund_portions(db, owner_id, data, [(None, data.amount)], exclude_tx_id=existing.id)
        except HTTPException:
            return False
        expected = sorted((cat_id or "", amt) for cat_id, amt in computed)
        return expected == actual
    return True


def post_transaction_with_status(
    db: Session,
    owner_id: str,
    data: TransactionIn,
    source: str = "manual",
    source_ref: str | None = None,
) -> tuple[Transaction, bool]:
    lock_owner(db, owner_id)
    reference = source_ref or data.source_ref or None
    if reference:
        existing = db.scalar(
            select(Transaction).where(
                Transaction.owner_id == owner_id,
                Transaction.source == source,
                Transaction.source_ref == reference,
            )
        )
        if existing:
            if not transaction_matches_input(db, owner_id, existing, data):
                raise HTTPException(409, "Referensi sudah digunakan untuk transaksi berbeda.")
            return existing, False
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
    return tx, True


def post_transaction(
    db: Session,
    owner_id: str,
    data: TransactionIn,
    source: str = "manual",
    source_ref: str | None = None,
) -> Transaction:
    return post_transaction_with_status(db, owner_id, data, source=source, source_ref=source_ref)[0]


def _validate_parent_expense_update(
    db: Session,
    owner_id: str,
    tx: Transaction,
    data: TransactionIn,
    portions: list[tuple[str | None, int]],
) -> None:
    child_refunds = list(
        db.scalars(
            select(Transaction).where(Transaction.owner_id == owner_id, Transaction.original_id == tx.id)
        ).all()
    )
    if not child_refunds:
        return
    if data.kind != "expense":
        raise HTTPException(409, "Pengeluaran yang memiliki refund tidak dapat diubah jenisnya.")
    if any(r.date < data.date for r in child_refunds):
        raise HTTPException(409, "Tanggal pengeluaran tidak boleh setelah tanggal refund yang tertaut.")
    refunded_by_cat: dict[str | None, int] = defaultdict(int)
    for cat_id, total in db.execute(
        select(Split.category_id, func.sum(func.abs(Split.amount)))
        .where(Split.owner_id == owner_id, Split.transaction_id.in_([r.id for r in child_refunds]))
        .group_by(Split.category_id)
    ).all():
        refunded_by_cat[cat_id] += int(total or 0)
    new_by_cat: dict[str | None, int] = defaultdict(int)
    for cat_id, amt in portions:
        new_by_cat[cat_id] += amt
    if sum(refunded_by_cat.values()) > data.amount or any(
        refunded_amt > new_by_cat.get(cat_id, 0) for cat_id, refunded_amt in refunded_by_cat.items()
    ):
        raise HTTPException(409, "Nominal atau kategori baru lebih kecil dari refund yang sudah tertaut.")


def _validate_allocated_income_update(db: Session, owner_id: str, tx: Transaction, data: TransactionIn) -> None:
    linked_reserves = list(
        db.scalars(select(Reserve).where(Reserve.owner_id == owner_id, Reserve.income_id == tx.id)).all()
    )
    if not linked_reserves:
        return
    total_allocated = sum(r.amount for r in linked_reserves)
    if data.kind != "income" or data.account_id != tx.account_id or data.amount < total_allocated:
        raise HTTPException(
            409,
            "Pemasukan yang sudah dialokasikan ke pos cadangan tidak dapat diubah jenis, dompet, atau nominal di bawah alokasi.",
        )
    app_ids = list({r.application_id for r in linked_reserves})
    earliest_alloc_date = db.scalar(
        select(func.min(Allocation.date)).where(Allocation.owner_id == owner_id, Allocation.id.in_(app_ids))
    )
    if earliest_alloc_date and data.date > earliest_alloc_date:
        raise HTTPException(409, "Tanggal pemasukan tidak boleh setelah tanggal penerapan alokasi cadangan.")


def update_transaction(db: Session, owner_id: str, key: str, data: TransactionIn) -> Transaction:
    lock_owner(db, owner_id)
    tx = owned(db, Transaction, owner_id, key)
    if data.original_id == tx.id:
        fail("Transaksi tidak dapat merujuk dirinya sendiri.")
    portions = _validate_and_prepare_tx(db, owner_id, data, exclude_tx_id=tx.id)
    _validate_parent_expense_update(db, owner_id, tx, data, portions)
    _validate_allocated_income_update(db, owner_id, tx, data)
    _reverse_reserve_movements(db, owner_id, tx.id)
    db.execute(delete(Entry).where(Entry.owner_id == owner_id, Entry.transaction_id == tx.id))
    db.execute(delete(Split).where(Split.owner_id == owner_id, Split.transaction_id == tx.id))
    for field, value in data.model_dump(exclude={"source_ref", "splits"}).items():
        setattr(tx, field, value)
    db.flush()
    _write_entries_and_splits(db, owner_id, tx, data, portions)
    db.flush()
    return tx


def remove_transaction_records(
    db: Session,
    owner_id: str,
    tx: Transaction,
    *,
    allow_cascade_reserves: bool = False,
) -> None:
    has_refund = db.scalar(
        select(Transaction.id)
        .where(Transaction.owner_id == owner_id, Transaction.original_id == tx.id)
        .limit(1)
    )
    if has_refund:
        raise HTTPException(409, "Hapus transaksi refund yang tertaut terlebih dahulu sebelum menghapus pengeluaran asal.")
    linked_reserve_ids = list(
        db.scalars(select(Reserve.id).where(Reserve.owner_id == owner_id, Reserve.income_id == tx.id)).all()
    )
    if linked_reserve_ids:
        if not allow_cascade_reserves:
            raise HTTPException(409, "Pemasukan yang sudah dialokasikan ke pos cadangan tidak dapat dihapus.")
        db.execute(
            delete(ReserveMovement).where(
                ReserveMovement.owner_id == owner_id,
                ReserveMovement.reserve_id.in_(linked_reserve_ids),
            )
        )
        db.execute(
            delete(Reserve).where(
                Reserve.owner_id == owner_id,
                Reserve.id.in_(linked_reserve_ids),
            )
        )
    _reverse_reserve_movements(db, owner_id, tx.id)
    db.execute(
        update(Evidence)
        .where(Evidence.owner_id == owner_id, Evidence.transaction_id == tx.id)
        .values(transaction_id=None)
    )
    db.execute(delete(Entry).where(Entry.owner_id == owner_id, Entry.transaction_id == tx.id))
    db.execute(delete(Split).where(Split.owner_id == owner_id, Split.transaction_id == tx.id))
    db.delete(tx)


def delete_transaction(db: Session, owner_id: str, key: str) -> None:
    lock_owner(db, owner_id)
    tx = owned(db, Transaction, owner_id, key)
    remove_transaction_records(db, owner_id, tx)
    db.flush()


def serialize_transactions(
    db: Session,
    owner_id: str,
    txs: list[Transaction],
    accounts_map: dict[str, Account] | None = None,
    category_names: dict[str, str] | None = None,
    splits_by_tx: dict[str, list[Split]] | None = None,
) -> list[dict]:
    """Serialize any number of transactions in O(1) SQL queries (zero N+1)."""
    if not txs:
        return []
    if accounts_map is None:
        accounts_map = {a.id: a for a in rows(db, Account, owner_id)}
    if category_names is None:
        category_names = {c.id: c.name for c in rows(db, Category, owner_id)}
    if splits_by_tx is None:
        tx_ids = [tx.id for tx in txs]
        splits_by_tx = defaultdict(list)
        for s in db.scalars(select(Split).where(Split.owner_id == owner_id, Split.transaction_id.in_(tx_ids))).all():
            splits_by_tx[s.transaction_id].append(s)

    result = []
    for tx in txs:
        tx_split_items = []
        tx_split_names: list[str] = []
        for s in splits_by_tx.get(tx.id, ()):
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
        acc = accounts_map.get(tx.account_id)
        to_acc = accounts_map.get(tx.to_account_id) if tx.to_account_id else None
        result.append(
            {
                **columns(tx),
                "account_name": acc.name if acc else None,
                "to_account_name": to_acc.name if to_acc else None,
                "category_name": cat_label,
                "splits": tx_split_items,
            }
        )
    return result


def transaction_dict(db: Session, tx: Transaction) -> dict:
    return serialize_transactions(db, tx.owner_id, [tx])[0]


def transactions(db: Session, owner_id: str, start: date, end: date) -> list[Transaction]:
    if start > end:
        fail("Tanggal awal harus sebelum tanggal akhir.")
    return list(
        db.scalars(
            select(Transaction)
            .where(Transaction.owner_id == owner_id, Transaction.date.between(start, end))
            .order_by(Transaction.date.desc(), Transaction.created_at.desc())
        ).all()
    )
