from datetime import date, datetime
import hashlib
import json
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import func, select

from .calculations import cycle, divide
from .db import lock_owner
from .ledger import active_reserves, balance, fail, owned
from .models import Account, Allocation, Category, Goal, Reserve, Scheme, Transaction
from .schemas import ApplyIn, SchemeIn


def today():
    return datetime.now(ZoneInfo("Asia/Jakarta")).date()


def validate_scheme(db, owner_id, payload: SchemeIn):
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


def plan_allocation(db, owner_id, scheme_id, data: ApplyIn, persist=False):
    lock_owner(db, owner_id)
    scheme = owned(db, Scheme, owner_id, scheme_id)
    signature = {"income_ids": sorted(set(data.income_ids)), "date": data.date.isoformat(), "scheme_id": scheme_id}
    if len(signature["income_ids"]) != len(data.income_ids):
        fail("Pemasukan tidak boleh dipilih dua kali.")
    previous = db.scalar(select(Allocation).where(Allocation.owner_id == owner_id, Allocation.request_id == data.request_id))
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
    free = {}
    for key in signature["income_ids"]:
        tx = owned(db, Transaction, owner_id, key)
        account = owned(db, Account, owner_id, tx.account_id)
        if tx.kind != "income" or tx.date > data.date or not account.opening_date or tx.date < account.opening_date:
            fail("Pilih pemasukan setelah tanggal acuan pada dompet dengan saldo terverifikasi.")
        if account.id not in free:
            # Revalidate against today's wallet balance so historical dates cannot over-reserve.
            def available(day):
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
    fixed_totals = db.execute(select(Reserve.pot_name, func.sum(Reserve.amount)).join(
        Allocation, Reserve.application_id == Allocation.id).where(
            Allocation.scheme_id == scheme_id, Allocation.cycle_start == period).group_by(Reserve.pot_name)).all()
    used_fixed = {name: int(amount) for name, amount in fixed_totals}
    values, left = divide(basis, scheme.rules, used_fixed)
    result = {"basis": basis, "remaining": left, "applicable": left >= 0,
              "items": [{"name": rule["name"], "amount": val} for rule, val in zip(scheme.rules, values)]}
    revision_data = [signature, scheme.rules, result, [(tx.id, value) for tx, value in sources]]
    result["revision"] = hashlib.sha256(json.dumps(revision_data, sort_keys=True).encode()).hexdigest()
    if not persist:
        return result
    if left < 0:
        fail("Rencana melebihi saldo bebas. Sesuaikan aturan terlebih dahulu.")
    if data.revision != result["revision"]:
        raise HTTPException(409, "Buka pratinjau terbaru dan konfirmasi kembali.")
    application = Allocation(owner_id=owner_id, scheme_id=scheme_id, date=data.date, cycle_start=period,
                             request_id=data.request_id, snapshot={"input": signature, "result": result, "rules": scheme.rules})
    db.add(application)
    db.flush()
    index = 0
    for rule, needed in zip(scheme.rules, values):
        while needed:
            tx, available = sources[index]
            take = min(available, needed)
            db.add(Reserve(owner_id=owner_id, application_id=application.id, scheme_id=scheme.id,
                income_id=tx.id, account_id=tx.account_id, pot_name=rule["name"], goal_id=rule.get("goal_id"),
                amount=take, remaining=take, category_ids=rule.get("category_ids", []),
                expires=None if rule.get("rollover") or rule.get("goal_id") else expires))
            needed -= take
            sources[index][1] -= take
            if sources[index][1] == 0:
                index += 1
    db.flush()
    return result
