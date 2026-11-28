"""Single-request dashboard bootstrap assembly service (read-only, zero advisory locks)."""
import re
from datetime import date, datetime

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..core.config import JAKARTA
from ..models import Account, Category
from .accounts import list_accounts_with_stats
from .common import columns, rows
from .planning import list_goals_with_reserves
from .reviews import list_connections, list_reviews
from .settings import cycle_month_for_date, get_settings, period_for_month, resolve_period
from .summary import summary as build_summary


def build_bootstrap(
    db: Session,
    owner_id: str,
    *,
    month: str | None = None,
    start: date | None = None,
    end: date | None = None,
) -> dict:
    today_date = datetime.now(JAKARTA).date()
    user_settings = get_settings(db, owner_id)
    start_day = user_settings.get("monthly_start_day", 1)

    active_month = month
    if start is not None or end is not None:
        period_start, period_end = resolve_period(start, end, settings=user_settings)
        if not active_month:
            active_month = cycle_month_for_date(period_end, start_day)
    else:
        if active_month:
            if not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", active_month):
                raise HTTPException(422, "Format bulan harus YYYY-MM dengan bulan 01–12.")
            year = int(active_month[:4])
            if not 1970 <= year <= 2100:
                raise HTTPException(422, "Tahun bulan di luar rentang yang didukung.")
        else:
            active_month = cycle_month_for_date(today_date, start_day)
        period_start, period_end = period_for_month(active_month, start_day)

    accounts_orm = list(rows(db, Account, owner_id))
    categories_orm = list(rows(db, Category, owner_id))

    accounts_data = list_accounts_with_stats(db, owner_id, today_date, preloaded_accounts=accounts_orm)
    balances_as_of_today = {acc["id"]: acc["balance"] for acc in accounts_data}
    categories_data = [columns(c) for c in categories_orm]

    summary_data = build_summary(
        db,
        owner_id,
        period_start,
        period_end,
        accounts_list=accounts_orm,
        categories_list=categories_orm,
        settings=user_settings,
        balance_as_of=today_date,
        precomputed_balances=balances_as_of_today,
    )

    return {
        "month": active_month,
        "settings": user_settings,
        "accounts": accounts_data,
        "categories": categories_data,
        "transactions": summary_data["transactions"],
        "reviews": list_reviews(db, owner_id),
        "budgets": summary_data["budgets"],
        "goals": list_goals_with_reserves(db, owner_id),
        "summary": summary_data,
        "connections": list_connections(db, owner_id),
    }
