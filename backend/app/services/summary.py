"""Budgets and read-only financial summary powered by SQL aggregation (no advisory locks, no N+1)."""
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..core.config import JAKARTA
from ..core.db import lock_owner
from ..models import Account, Budget, Category, Evidence, Split, Transaction
from ..schemas import BudgetIn
from .accounts import batch_balances
from .calculations import cycle
from .common import columns, fail, owned, rows
from .settings import get_settings
from .transactions import serialize_transactions, transactions


def _spent_by_category(db: Session, owner_id: str, start: date, end: date) -> dict[str, int]:
    rows_agg = db.execute(
        select(Split.category_id, func.coalesce(func.sum(Split.amount), 0))
        .join(Transaction, Transaction.id == Split.transaction_id)
        .where(
            Transaction.owner_id == owner_id,
            Transaction.date.between(start, end),
            Split.role != "income",
            Split.category_id.is_not(None),
        )
        .group_by(Split.category_id)
    ).all()
    return {cat_id: int(total) for cat_id, total in rows_agg}


def list_budgets(
    db: Session,
    owner_id: str,
    start: date,
    end: date,
    *,
    cats_map: dict[str, Category] | None = None,
    spent_by_cat: dict[str, int] | None = None,
) -> list[dict]:
    cats = cats_map if cats_map is not None else {c.id: c for c in rows(db, Category, owner_id)}
    children_map: dict[str, list[str]] = defaultdict(list)
    for c in cats.values():
        if c.parent_id:
            children_map[c.parent_id].append(c.id)

    spent_map = spent_by_cat if spent_by_cat is not None else _spent_by_category(db, owner_id, start, end)
    budget_rows = db.scalars(select(Budget).where(Budget.owner_id == owner_id)).all()
    result = []
    for b in budget_rows:
        cat = cats.get(b.category_id)
        if not cat:
            continue
        cat_ids = [b.category_id, *children_map.get(b.category_id, [])]
        spent = max(0, sum(spent_map.get(cid, 0) for cid in cat_ids))
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


def delete_budget(db: Session, owner_id: str, key: str) -> None:
    lock_owner(db, owner_id)
    row = owned(db, Budget, owner_id, key)
    db.delete(row)
    db.flush()


def _period_totals(db: Session, owner_id: str, start: date, end: date) -> dict:
    agg = db.execute(
        select(Split.role, func.coalesce(func.sum(Split.amount), 0))
        .join(Transaction, Transaction.id == Split.transaction_id)
        .where(Transaction.owner_id == owner_id, Transaction.date.between(start, end))
        .group_by(Split.role)
    ).all()
    inc = exp = 0
    for role, total in agg:
        if role == "income":
            inc += int(total)
        else:
            exp += int(total)
    return {"start": start, "end": end, "income": inc, "expense": exp, "net": inc - exp}


def summary(
    db: Session,
    owner_id: str,
    start: date,
    end: date,
    *,
    accounts_list: list[Account] | None = None,
    categories_list: list[Category] | None = None,
    settings: dict | None = None,
) -> dict:
    txs = transactions(db, owner_id, start, end)
    cats_list = categories_list if categories_list is not None else list(rows(db, Category, owner_id))
    accs_list = accounts_list if accounts_list is not None else list(rows(db, Account, owner_id))
    cats_map = {c.id: c for c in cats_list}
    category_names = {c.id: c.name for c in cats_list}
    accounts_map = {a.id: a for a in accs_list}

    splits_by_tx: dict[str, list[Split]] = defaultdict(list)
    if txs:
        parts = db.scalars(
            select(Split)
            .join(Transaction, Transaction.id == Split.transaction_id)
            .where(Transaction.owner_id == owner_id, Transaction.date.between(start, end))
        ).all()
        for part in parts:
            splits_by_tx[part.transaction_id].append(part)

    income = expense = 0
    categories_totals: dict[str, int] = defaultdict(int)
    income_categories: dict[str, int] = defaultdict(int)
    spent_by_cat: dict[str, int] = defaultdict(int)
    partial_history = False

    for tx in txs:
        for account_id in (tx.account_id, tx.to_account_id):
            if (
                account_id
                and account_id in accounts_map
                and accounts_map[account_id].opening_date
                and tx.date < accounts_map[account_id].opening_date
            ):
                partial_history = True
        for s in splits_by_tx.get(tx.id, ()):
            if s.role == "income":
                income += s.amount
                inc_name = category_names.get(s.category_id, "Pemasukan lainnya")
                income_categories[inc_name] += s.amount
            else:
                expense += s.amount
                if s.category_id:
                    spent_by_cat[s.category_id] += s.amount
                name = "Biaya admin" if s.role == "fee" else category_names.get(s.category_id, "Belum dikategorikan")
                categories_totals[name] += s.amount

    detail = serialize_transactions(
        db,
        owner_id,
        txs,
        accounts_map=accounts_map,
        category_names=category_names,
        splits_by_tx=splits_by_tx,
    )

    begin = datetime.combine(start, time.min, JAKARTA) if start > date.min else None
    finish = datetime.combine(end, time.max, JAKARTA)
    pending = select(func.count()).select_from(Evidence).where(
        Evidence.owner_id == owner_id,
        Evidence.status == "review",
        Evidence.occurred_at <= finish.astimezone(timezone.utc),
    )
    if begin:
        pending = pending.where(Evidence.occurred_at >= begin.astimezone(timezone.utc))
    reviews = int(db.scalar(pending) or 0)

    span_days = (end - start).days + 1
    prev_summary = None
    if 1 <= span_days <= 370 and start > date(1971, 1, 1):
        prev_end = start - timedelta(days=1)
        user_settings = settings if settings is not None else get_settings(db, owner_id)
        start_day = user_settings.get("monthly_start_day", 1)
        if 25 <= span_days <= 35:
            prev_start, _ = cycle(start_day, prev_end)
        else:
            prev_start = prev_end - timedelta(days=span_days - 1)
        prev_summary = _period_totals(db, owner_id, prev_start, prev_end)

    balances = batch_balances(db, owner_id, accs_list, end)

    return {
        "start": start,
        "end": end,
        "income": income,
        "expense": expense,
        "net": income - expense,
        "categories": [{"name": n, "amount": v} for n, v in sorted(categories_totals.items(), key=lambda x: -x[1])],
        "income_categories": [
            {"name": n, "amount": v} for n, v in sorted(income_categories.items(), key=lambda x: -x[1])
        ],
        "budgets": list_budgets(db, owner_id, start, end, cats_map=cats_map, spent_by_cat=spent_by_cat),
        "previous": prev_summary,
        "reviews": reviews,
        "partial_history": partial_history,
        "accounts": [{**columns(a), "balance": balances.get(a.id)} for a in accs_list],
        "transactions": detail,
    }
