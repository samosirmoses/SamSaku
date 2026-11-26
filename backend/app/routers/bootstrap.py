"""Single-request bootstrap endpoint replacing the 7-request frontend waterfall."""
import re
from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..core.auth import owner
from ..core.config import JAKARTA
from ..core.db import get_db
from ..models import Account, Category, Evidence
from ..services.accounts import list_accounts_with_stats
from ..services.common import columns, rows
from ..services.settings import cycle_month_for_date, get_settings, period_for_month, resolve_period
from ..services.summary import summary as build_summary

router = APIRouter(prefix="/v1", tags=["bootstrap"])


@router.get("/bootstrap")
def bootstrap(
    month: str | None = None,
    start: date | None = None,
    end: date | None = None,
    db: Session = Depends(get_db),
    user: str = Depends(owner),
):
    today_date = datetime.now(JAKARTA).date()
    user_settings = get_settings(db, user)
    start_day = user_settings.get("monthly_start_day", 1)

    active_month = month
    if start is not None or end is not None:
        period_start, period_end = resolve_period(start, end, settings=user_settings)
        if not active_month:
            active_month = cycle_month_for_date(period_end, start_day)
    else:
        if active_month:
            if not re.fullmatch(r"\d{4}-\d{2}", active_month):
                raise HTTPException(422, "Format bulan harus YYYY-MM.")
        else:
            active_month = cycle_month_for_date(today_date, start_day)
        period_start, period_end = period_for_month(active_month, start_day)

    accounts_orm = list(rows(db, Account, user))
    categories_orm = list(rows(db, Category, user))

    accounts_data = list_accounts_with_stats(db, user, today_date, preloaded_accounts=accounts_orm)
    categories_data = [columns(c) for c in categories_orm]

    summary_data = build_summary(
        db,
        user,
        period_start,
        period_end,
        accounts_list=accounts_orm,
        categories_list=categories_orm,
        settings=user_settings,
    )

    reviews_data = [
        columns(item)
        for item in db.scalars(
            select(Evidence)
            .where(Evidence.owner_id == user, Evidence.status == "review")
            .order_by(Evidence.occurred_at.desc())
        )
    ]

    latest = dict(
        db.execute(
            select(Evidence.source, func.max(Evidence.received_at))
            .where(Evidence.owner_id == user)
            .group_by(Evidence.source)
        ).all()
    )
    connections_data = [{"source": source, "last_received_at": latest.get(source)} for source in ("bca", "gopay", "telegram")]

    return {
        "month": active_month,
        "settings": user_settings,
        "accounts": accounts_data,
        "categories": categories_data,
        "transactions": summary_data["transactions"],
        "reviews": reviews_data,
        "budgets": summary_data["budgets"],
        "summary": summary_data,
        "connections": connections_data,
    }
