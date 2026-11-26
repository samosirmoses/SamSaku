"""Income allocation schemes, goals, and batched pot reserve summaries."""
import hashlib
import json
from collections import defaultdict
from datetime import date, datetime

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..core.config import JAKARTA
from ..core.db import lock_owner
from ..models import Account, Allocation, Category, Goal, Reserve, Scheme, Transaction
from ..schemas import ApplyIn, SchemeIn
from .accounts import active_reserves, balance
from .calculations import cycle, divide
from .common import columns, fail, owned, rows


def today() -> date:
    return datetime.now(JAKARTA).date()


def list_goals_with_reserves(db: Session, owner_id: str) -> list[dict]:
    totals = dict(
        db.execute(
            select(Reserve.goal_id, func.sum(Reserve.remaining))
            .where(Reserve.owner_id == owner_id, Reserve.goal_id.is_not(None))
            .group_by(Reserve.goal_id)
        ).all()
    )
    return [{**columns(g), "reserved": int(totals.get(g.id, 0) or 0)} for g in rows(db, Goal, owner_id)]


def list_schemes_with_pots(db: Session, owner_id: str, as_of: date | None = None) -> list[dict]:
    day = as_of or today()
    scheme_rows = list(rows(db, Scheme, owner_id))
    if not scheme_rows:
        return []
    pots_by_scheme: dict[str, list[dict]] = defaultdict(list)
    totals = db.execute(
        select(
            Reserve.scheme_id,
            Reserve.pot_name,
            func.coalesce(func.sum(Reserve.amount), 0),
            func.coalesce(func.sum(Reserve.remaining), 0),
        )
        .join(Allocation, Allocation.id == Reserve.application_id)
        .where(
            Reserve.owner_id == owner_id,
            Allocation.date <= day,
            (Reserve.expires.is_(None)) | (Reserve.expires > day),
        )
        .group_by(Reserve.scheme_id, Reserve.pot_name)
    ).all()
    for scheme_id, pot_name, amount, remaining in totals:
        amt = int(amount)
        rem = int(remaining)
        pots_by_scheme[scheme_id].append(
            {"name": pot_name, "allocated": amt, "used": amt - rem, "remaining": rem}
        )
    return [{**columns(s), "pots": pots_by_scheme.get(s.id, [])} for s in scheme_rows]


def validate_scheme(db: Session, owner_id: str, payload: SchemeIn) -> None:
    seen = set()
    names = set()
    remainder = percent = 0
    for rule in payload.rules:
        if rule.name.casefold() in names:
            fail("Nama pos harus unik.")
        names.add(rule.name.casefold())
        if rule.mode == "percent":
            percent += rule.value
        elif rule.mode == "remainder":
            remainder += 1
            if rule.value:
                fail("Nilai pos sisa dihitung otomatis.")
        if rule.goal_id:
            owned(db, Goal, owner_id, rule.goal_id)
        for category_id in rule.category_ids:
            cat = owned(db, Category, owner_id, category_id)
            if category_id in seen or cat.kind != "expense":
                fail("Pilih satu pos per kategori pengeluaran.")
            seen.add(category_id)
    if remainder > 1 or percent > 100:
        fail("Hanya satu pos sisa dan total persentase maksimal 100%.")


def plan_allocation(db: Session, owner_id: str, scheme_id: str, data: ApplyIn, persist: bool = False) -> dict:
    lock_owner(db, owner_id)
    scheme = owned(db, Scheme, owner_id, scheme_id)
    signature = {"income_ids": sorted(set(data.income_ids)), "date": data.date.isoformat(), "scheme_id": scheme_id}
    if len(signature["income_ids"]) != len(data.income_ids):
        fail("Pemasukan tidak boleh dipilih dua kali.")
    previous = db.scalar(
        select(Allocation).where(Allocation.owner_id == owner_id, Allocation.request_id == data.request_id)
    )
    if previous:
        if previous.snapshot.get("input") != signature:
            fail("Kode konfirmasi telah digunakan untuk pembagian lain.")
        return previous.snapshot["result"]

    period, expires = cycle(scheme.cycle_day, data.date)
    current = today()
    if persist and not period <= current < expires:
        fail("Penerapan alokasi hanya tersedia pada siklus berjalan.")
    if persist and data.date > current:
        fail("Tanggal penerapan tidak boleh berada di masa depan.")
    sources = []
    free: dict[str, int] = {}
    for key in signature["income_ids"]:
        tx = owned(db, Transaction, owner_id, key)
        account = owned(db, Account, owner_id, tx.account_id)
        if tx.kind != "income" or tx.date > data.date or not account.opening_date or tx.date < account.opening_date:
            fail("Pilih pemasukan setelah tanggal acuan pada dompet dengan saldo terverifikasi.")
        if account.id not in free:
            def available(day: date) -> int:
                account_balance = balance(db, account, day)
                if account_balance is None:
                    return 0
                return max(0, account_balance - sum(r.remaining for r in active_reserves(db, owner_id, account.id, day)))

            free[account.id] = min(available(data.date), available(current))
        consumed = int(db.scalar(select(func.sum(Reserve.amount)).where(Reserve.income_id == key)) or 0)
        amount = min(max(0, tx.amount - consumed), free[account.id])
        if amount:
            sources.append([tx, amount])
            free[account.id] -= amount
    basis = sum(value for _, value in sources)
    if not basis:
        fail("Tidak ada dana bebas dari pemasukan yang dipilih.")
    fixed_totals = db.execute(
        select(Reserve.pot_name, func.sum(Reserve.amount))
        .join(Allocation, Reserve.application_id == Allocation.id)
        .where(Allocation.scheme_id == scheme_id, Allocation.cycle_start == period)
        .group_by(Reserve.pot_name)
    ).all()
    used_fixed = {name: int(amount) for name, amount in fixed_totals}
    values, left = divide(basis, scheme.rules, used_fixed)
    result = {
        "basis": basis,
        "remaining": left,
        "applicable": left >= 0,
        "items": [{"name": rule["name"], "amount": val} for rule, val in zip(scheme.rules, values)],
    }
    revision_data = [signature, scheme.rules, result, [(tx.id, value) for tx, value in sources]]
    result["revision"] = hashlib.sha256(json.dumps(revision_data, sort_keys=True).encode()).hexdigest()
    if not persist:
        return result
    if left < 0:
        fail("Rencana melebihi saldo bebas. Sesuaikan aturan terlebih dahulu.")
    if data.revision != result["revision"]:
        raise HTTPException(409, "Buka pratinjau terbaru dan konfirmasi kembali.")
    application = Allocation(
        owner_id=owner_id,
        scheme_id=scheme_id,
        date=data.date,
        cycle_start=period,
        request_id=data.request_id,
        snapshot={"input": signature, "result": result, "rules": scheme.rules},
    )
    db.add(application)
    db.flush()
    index = 0
    for rule, needed in zip(scheme.rules, values):
        while needed:
            tx, avail = sources[index]
            take = min(avail, needed)
            db.add(
                Reserve(
                    owner_id=owner_id,
                    application_id=application.id,
                    scheme_id=scheme.id,
                    income_id=tx.id,
                    account_id=tx.account_id,
                    pot_name=rule["name"],
                    goal_id=rule.get("goal_id"),
                    amount=take,
                    remaining=take,
                    category_ids=rule.get("category_ids", []),
                    expires=None if rule.get("rollover") or rule.get("goal_id") else expires,
                )
            )
            needed -= take
            sources[index][1] -= take
            if sources[index][1] == 0:
                index += 1
    db.flush()
    return result
