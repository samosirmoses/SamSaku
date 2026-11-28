"""User cycle/wallet settings and billing-cycle date range resolution."""
import logging
import re
from calendar import monthrange
from datetime import date, datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from ..core.config import JAKARTA
from ..core.db import lock_owner
from ..models import (
    Account,
    Alias,
    Allocation,
    Budget,
    Category,
    Entry,
    Evidence,
    FileJob,
    Goal,
    ImportEntry,
    Merchant,
    Reserve,
    ReserveMovement,
    Scheme,
    Split,
    Transaction,
    UserSettings,
)
from ..schemas import DataResetIn, SettingsIn
from .calculations import cycle
from .common import owned
from .jobs import purge_remote_file

logger = logging.getLogger("samsaku.settings")


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
    if not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", month):
        raise ValueError("Format bulan harus YYYY-MM dengan bulan 01–12.")
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


def reset_owner_data(db: Session, owner_id: str, data: DataResetIn) -> dict:
    expected = "WIPE SEMUA" if data.mode == "wipe" else "RESET"
    if data.confirm.strip().upper() != expected:
        raise HTTPException(
            status_code=400,
            detail=f'Konfirmasi tidak cocok. Ketik "{expected}" untuk melanjutkan.',
        )

    if data.mode == "partial" and not any(
        [
            data.reset_transactions,
            data.clear_evidence,
            data.zero_opening_balances,
            data.clear_budgets,
        ]
    ):
        raise HTTPException(status_code=400, detail="Pilih minimal satu jenis data untuk direset.")

    lock_owner(db, owner_id)

    deleted = {
        "transactions": 0,
        "evidence": 0,
        "file_jobs": 0,
        "budgets": 0,
        "accounts": 0,
        "categories": 0,
        "merchants": 0,
        "schemes": 0,
        "goals": 0,
    }
    zeroed_accounts = 0

    def _del(model) -> int:
        res = db.execute(delete(model).where(model.owner_id == owner_id))
        return int(res.rowcount or 0)

    def _purge_external_keys(keys: list[str]) -> None:
        for obj_key in keys:
            for attempt in range(2):
                try:
                    purge_remote_file(obj_key)
                    break
                except Exception as exc:
                    if attempt == 1:
                        logger.warning("Failed to purge remote object %s after reset: %s", obj_key, exc)

    if data.mode == "wipe":
        object_keys = [
            k
            for k in db.scalars(
                select(FileJob.object_key).where(FileJob.owner_id == owner_id, FileJob.object_key.is_not(None))
            )
            if k
        ]
        job_ids = list(db.scalars(select(FileJob.id).where(FileJob.owner_id == owner_id)))
        if job_ids:
            db.execute(delete(ImportEntry).where(ImportEntry.job_id.in_(job_ids)))
        deleted["file_jobs"] = _del(FileJob)
        deleted["evidence"] = _del(Evidence)
        _del(ReserveMovement)
        _del(Reserve)
        _del(Allocation)
        _del(Entry)
        _del(Split)
        db.execute(update(Transaction).where(Transaction.owner_id == owner_id).values(original_id=None))
        deleted["transactions"] = _del(Transaction)
        deleted["budgets"] = _del(Budget)
        _del(UserSettings)
        _del(Alias)
        deleted["merchants"] = _del(Merchant)
        deleted["schemes"] = _del(Scheme)
        deleted["goals"] = _del(Goal)
        db.execute(update(Category).where(Category.owner_id == owner_id).values(parent_id=None))
        deleted["categories"] = _del(Category)
        deleted["accounts"] = _del(Account)
        db.commit()
        _purge_external_keys(object_keys)
        return {"mode": "wipe", "deleted": deleted, "zeroed_accounts": zeroed_accounts}

    object_keys: list[str] = []
    if data.clear_evidence:
        object_keys = [
            k
            for k in db.scalars(
                select(FileJob.object_key).where(FileJob.owner_id == owner_id, FileJob.object_key.is_not(None))
            )
            if k
        ]
        job_ids = list(db.scalars(select(FileJob.id).where(FileJob.owner_id == owner_id)))
        if job_ids:
            db.execute(delete(ImportEntry).where(ImportEntry.job_id.in_(job_ids)))
        deleted["file_jobs"] = _del(FileJob)
        deleted["evidence"] = _del(Evidence)

    if data.reset_transactions:
        if not data.clear_evidence:
            db.execute(
                update(Evidence)
                .where(Evidence.owner_id == owner_id, Evidence.transaction_id.is_not(None))
                .values(transaction_id=None)
            )
        _del(ReserveMovement)
        _del(Reserve)
        _del(Allocation)
        _del(Entry)
        _del(Split)
        db.execute(update(Transaction).where(Transaction.owner_id == owner_id).values(original_id=None))
        deleted["transactions"] = _del(Transaction)

    if data.zero_opening_balances:
        res = db.execute(
            update(Account)
            .where(Account.owner_id == owner_id, Account.opening_balance.is_not(None))
            .values(opening_balance=0)
        )
        zeroed_accounts = int(res.rowcount or 0)

    if data.clear_budgets:
        deleted["budgets"] = _del(Budget)

    db.commit()
    if object_keys:
        _purge_external_keys(object_keys)
    return {"mode": "partial", "deleted": deleted, "zeroed_accounts": zeroed_accounts}
