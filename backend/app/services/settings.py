"""User cycle/wallet settings and billing-cycle date range resolution."""
from calendar import monthrange
from datetime import date, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..core.config import JAKARTA
from ..core.db import lock_owner
from ..models import Account, UserSettings
from ..schemas import SettingsIn
from .calculations import cycle
from .common import owned


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


def resolve_period(
    start: date | None,
    end: date | None,
    db: Session | None = None,
    user: str | None = None,
    settings: dict | None = None,
) -> tuple[date, date]:
    cutoff = end or datetime.now(JAKARTA).date()
    if start:
        return start, cutoff
    if settings is not None:
        start_day = settings.get("monthly_start_day", 1)
    elif db is not None and user is not None:
        start_day = get_settings(db, user).get("monthly_start_day", 1)
    else:
        start_day = 1
    if start_day == 1:
        return cutoff.replace(day=1), cutoff
    cycle_start, _ = cycle(start_day, cutoff)
    return cycle_start, cutoff


def shift_month_str(month: str, delta: int) -> str:
    year, mon = map(int, month.split("-"))
    total = year * 12 + (mon - 1) + delta
    ny, nm = divmod(total, 12)
    return f"{ny:04d}-{nm + 1:02d}"


def cycle_month_for_date(day: date, start_day: int = 1) -> str:
    base = f"{day.year:04d}-{day.month:02d}"
    clamped = max(1, min(31, start_day or 1))
    if clamped == 1:
        return base
    boundary = min(clamped, monthrange(day.year, day.month)[1])
    if clamped >= 15:
        return shift_month_str(base, 1) if day.day >= boundary else base
    return shift_month_str(base, -1) if day.day < boundary else base


def period_for_month(month: str, start_day: int = 1) -> tuple[date, date]:
    y, m = map(int, month.split("-"))
    clamped = max(1, min(31, start_day or 1))
    if clamped == 1:
        return date(y, m, 1), date(y, m, monthrange(y, m)[1])
    if clamped >= 15:
        prev_y, prev_m = (y - 1, 12) if m == 1 else (y, m - 1)
        start_d = date(prev_y, prev_m, min(clamped, monthrange(prev_y, prev_m)[1]))
        end_d = date(y, m, min(clamped, monthrange(y, m)[1])) - timedelta(days=1)
        return start_d, end_d
    start_d = date(y, m, min(clamped, monthrange(y, m)[1]))
    next_y, next_m = (y + 1, 1) if m == 12 else (y, m + 1)
    end_d = date(next_y, next_m, min(clamped, monthrange(next_y, next_m)[1])) - timedelta(days=1)
    return start_d, end_d
