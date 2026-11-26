"""Account balance calculation (batched), active reserves, and account CRUD."""
from datetime import date

from fastapi import HTTPException
from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.orm import Session

from ..core.db import lock_owner
from ..models import (
    Account,
    Allocation,
    Entry,
    Evidence,
    Reserve,
    ReserveMovement,
    Split,
    Transaction,
    UserSettings,
)
from ..schemas import AccountEdit
from .common import columns, fail, owned, rows


def balance(db: Session, account: Account, as_of: date | None = None) -> int | None:
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


def batch_balances(
    db: Session,
    owner_id: str,
    accounts: list[Account],
    as_of: date | None = None,
) -> dict[str, int | None]:
    """Compute balances for all accounts of an owner in a single grouped SQL query."""
    if not accounts:
        return {}
    query = (
        select(Entry.account_id, func.coalesce(func.sum(Entry.delta), 0))
        .select_from(Entry)
        .join(Transaction, Transaction.id == Entry.transaction_id)
        .join(Account, Account.id == Entry.account_id)
        .where(
            Entry.owner_id == owner_id,
            Transaction.owner_id == owner_id,
            Account.owner_id == owner_id,
            Account.opening_date.is_not(None),
            Transaction.date >= Account.opening_date,
        )
        .group_by(Entry.account_id)
    )
    if as_of:
        query = query.where(Transaction.date <= as_of)
    deltas = {acc_id: int(total) for acc_id, total in db.execute(query).all()}
    result: dict[str, int | None] = {}
    for acc in accounts:
        if acc.opening_date is None or (as_of and as_of < acc.opening_date):
            result[acc.id] = None
        else:
            result[acc.id] = (acc.opening_balance or 0) + deltas.get(acc.id, 0)
    return result


def batch_reserved_totals(db: Session, owner_id: str, day: date) -> dict[str, int]:
    """Compute active reserved amounts per account in a single grouped SQL query."""
    query = (
        select(Reserve.account_id, func.coalesce(func.sum(Reserve.remaining), 0))
        .join(Allocation, Allocation.id == Reserve.application_id)
        .where(
            Reserve.owner_id == owner_id,
            Reserve.remaining > 0,
            Allocation.date <= day,
            (Reserve.expires.is_(None)) | (Reserve.expires > day),
        )
        .group_by(Reserve.account_id)
    )
    return {acc_id: int(total) for acc_id, total in db.execute(query).all()}


def batch_account_tx_counts(db: Session, owner_id: str) -> dict[str, int]:
    """Count distinct transactions per account in a single SQL query via account_entries."""
    query = (
        select(Entry.account_id, func.count(func.distinct(Entry.transaction_id)))
        .where(Entry.owner_id == owner_id)
        .group_by(Entry.account_id)
    )
    return {acc_id: int(cnt) for acc_id, cnt in db.execute(query).all()}


def account_tx_count(db: Session, owner_id: str, account_id: str) -> int:
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


def active_reserves(db: Session, owner_id: str, account_id: str, day: date):
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


def list_accounts_with_stats(
    db: Session,
    owner_id: str,
    as_of: date,
    preloaded_accounts: list[Account] | None = None,
) -> list[dict]:
    accounts_list = preloaded_accounts if preloaded_accounts is not None else list(rows(db, Account, owner_id))
    balances = batch_balances(db, owner_id, accounts_list, as_of)
    reserves = batch_reserved_totals(db, owner_id, as_of)
    tx_counts = batch_account_tx_counts(db, owner_id)
    result = []
    for account in accounts_list:
        money = balances.get(account.id)
        reserved = reserves.get(account.id, 0)
        result.append(
            {
                **columns(account),
                "balance": money,
                "reserved": reserved,
                "free_balance": money - reserved if money is not None else None,
                "tx_count": tx_counts.get(account.id, 0),
            }
        )
    return result


def edit_account(db: Session, owner_id: str, key: str, data: AccountEdit) -> Account:
    lock_owner(db, owner_id)
    account = owned(db, Account, owner_id, key)
    if data.name is not None:
        account.name = data.name
    if data.code is not None:
        account.code = data.code
    if data.kind is not None:
        account.kind = data.kind
    if "account_number" in data.model_fields_set:
        account.account_number = data.account_number
    if data.clear_opening:
        account.opening_date = None
        account.opening_balance = None
    elif data.opening_date is not None and data.opening_balance is not None:
        account.opening_date = data.opening_date
        account.opening_balance = data.opening_balance
    db.flush()
    return account


def delete_account(
    db: Session,
    owner_id: str,
    key: str,
    transfer_to: str | None = None,
    cascade: bool = False,
) -> None:
    from .transactions import remove_transaction_records

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
            db.execute(
                update(Reserve)
                .where(Reserve.owner_id == owner_id, Reserve.account_id == key)
                .values(account_id=target.id)
            )
        elif cascade:
            for tx in affected:
                remove_transaction_records(db, owner_id, tx)
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
