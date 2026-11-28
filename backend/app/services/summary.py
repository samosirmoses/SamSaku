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
            Split.owner_id == owner_id,
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
        percent = (spent * 100 + b.amount // 2) // b.amount if b.amount > 0 else 0
        status = "over" if spent > b.amount else "warning" if spent * 5 >= b.amount * 4 else "safe"
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


def _period_totals_and_categories(
    db: Session, owner_id: str, start: date, end: date, category_names: dict[str, str]
) -> tuple[dict, dict[str, int]]:
    agg = db.execute(
        select(Split.role, Split.category_id, func.coalesce(func.sum(Split.amount), 0))
        .join(Transaction, Transaction.id == Split.transaction_id)
        .where(Split.owner_id == owner_id, Transaction.owner_id == owner_id, Transaction.date.between(start, end))
        .group_by(Split.role, Split.category_id)
    ).all()
    inc = exp = 0
    cat_totals: dict[str, int] = defaultdict(int)
    for role, category_id, total in agg:
        val = int(total)
        if role == "income":
            inc += val
        else:
            exp += val
            name = "Biaya admin" if role == "fee" else category_names.get(category_id, "Belum dikategorikan")
            cat_totals[name] += val
    return {"start": start, "end": end, "income": inc, "expense": exp, "net": inc - exp}, cat_totals


def compute_cycle_pacing(
    start: date,
    end: date,
    *,
    budgets: list[dict],
    income: int,
    expense: int,
    as_of: date | None = None,
) -> dict:
    """Compute cycle pacing metrics and safe daily spending allowance."""
    today_date = as_of or datetime.now(JAKARTA).date()
    days_total = max(1, (end - start).days + 1)
    if today_date < start:
        days_elapsed = 0
        days_remaining = days_total
    elif today_date > end:
        days_elapsed = days_total
        days_remaining = 0
    else:
        days_elapsed = (today_date - start).days + 1
        days_remaining = (end - today_date).days + 1

    elapsed_percent = round(100 * days_elapsed / days_total)
    total_budget = sum(b["amount"] for b in budgets)
    total_budget_spent = sum(b["spent"] for b in budgets)
    budget_remaining = total_budget - total_budget_spent
    budget_spent_percent = round(100 * total_budget_spent / total_budget) if total_budget > 0 else 0

    if days_remaining <= 0:
        safe_daily_allowance = 0
    elif total_budget > 0:
        safe_daily_allowance = max(0, budget_remaining) // days_remaining
    elif income > 0:
        safe_daily_allowance = max(0, income - expense) // days_remaining
    else:
        safe_daily_allowance = 0

    allowance_basis = "budget" if total_budget > 0 else ("income" if income > 0 else "none")
    if total_budget == 0:
        pacing_status = "no_budget"
    elif total_budget_spent > total_budget:
        pacing_status = "over"
    elif budget_spent_percent >= 80 or budget_spent_percent >= elapsed_percent + 10:
        pacing_status = "ahead"
    else:
        pacing_status = "on_track"

    return {
        "as_of": today_date.isoformat(),
        "days_total": days_total,
        "days_elapsed": days_elapsed,
        "days_remaining": days_remaining,
        "elapsed_percent": elapsed_percent,
        "total_budget": total_budget,
        "total_budget_spent": total_budget_spent,
        "budget_remaining": budget_remaining,
        "budget_spent_percent": budget_spent_percent,
        "safe_daily_allowance": safe_daily_allowance,
        "allowance_basis": allowance_basis,
        "pacing_status": pacing_status,
    }


def summary(
    db: Session,
    owner_id: str,
    start: date,
    end: date,
    *,
    accounts_list: list[Account] | None = None,
    categories_list: list[Category] | None = None,
    settings: dict | None = None,
    balance_as_of: date | None = None,
    precomputed_balances: dict[str, int | None] | None = None,
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
            .where(Split.owner_id == owner_id, Transaction.owner_id == owner_id, Transaction.date.between(start, end))
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
    prev_cat_totals: dict[str, int] = {}
    if 1 <= span_days <= 370 and start > date(1971, 1, 1):
        prev_end = start - timedelta(days=1)
        user_settings = settings if settings is not None else get_settings(db, owner_id)
        start_day = user_settings.get("monthly_start_day", 1)
        if 25 <= span_days <= 35:
            prev_start, _ = cycle(start_day, prev_end)
        else:
            prev_start = prev_end - timedelta(days=span_days - 1)
        prev_summary, prev_cat_totals = _period_totals_and_categories(db, owner_id, prev_start, prev_end, category_names)

    category_deltas = []
    for name in set(categories_totals) | set(prev_cat_totals):
        curr_amt = categories_totals.get(name, 0)
        prev_amt = prev_cat_totals.get(name, 0)
        if curr_amt == 0 and prev_amt == 0:
            continue
        delta = curr_amt - prev_amt
        pct = round(100 * delta / prev_amt) if prev_amt > 0 else (100 if curr_amt > 0 else 0)
        category_deltas.append(
            {
                "name": name,
                "current": curr_amt,
                "previous": prev_amt,
                "delta": delta,
                "percent_change": pct,
            }
        )
    category_deltas.sort(key=lambda item: (-abs(item["delta"]), -item["current"], item["name"]))
    category_deltas = category_deltas[:8]

    budgets_data = list_budgets(db, owner_id, start, end, cats_map=cats_map, spent_by_cat=spent_by_cat)
    budget_alerts = [b for b in budgets_data if b["status"] in ("warning", "over")]
    pacing = compute_cycle_pacing(
        start,
        end,
        budgets=budgets_data,
        income=income,
        expense=expense,
        as_of=balance_as_of,
    )

    balances = (
        precomputed_balances
        if precomputed_balances is not None
        else batch_balances(db, owner_id, accs_list, balance_as_of or end)
    )

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
        "budgets": budgets_data,
        "budget_alerts": budget_alerts,
        "pacing": pacing,
        "category_deltas": category_deltas,
        "previous": prev_summary,
        "reviews": reviews,
        "partial_history": partial_history,
        "accounts": [{**columns(a), "balance": balances.get(a.id)} for a in accs_list],
        "transactions": detail,
    }
