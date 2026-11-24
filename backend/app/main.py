import os
from datetime import date, datetime
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .auth import configured_owner, owner, secret_matches
from .calculations import cycle
from .db import get_db, lock_owner
from .intake import JAKARTA, ingest
from .ledger import (
    account_tx_count,
    active_reserves,
    balance,
    columns,
    delete_account,
    delete_budget,
    delete_category,
    delete_transaction,
    edit_account,
    edit_category_item,
    fail,
    get_settings,
    list_budgets,
    owned,
    post_transaction,
    rows,
    summary,
    transaction_dict,
    transactions,
    update_settings,
    update_transaction,
    upsert_budget,
)
from .models import Account, Allocation, Category, Evidence, Goal, Reserve, Scheme, Transaction
from .planning import plan_allocation, validate_scheme
from .schemas import (
    AccountEdit,
    AccountIn,
    ApplyIn,
    BudgetIn,
    CategoryEdit,
    CategoryIn,
    EventIn,
    GoalIn,
    ResolveIn,
    SchemeIn,
    SettingsIn,
    TransactionIn,
)
from .tools_api import router as tools_router
from .telegram import router as telegram_router, start_telegram_poller_if_enabled

app = FastAPI(title="SamSaku", version="1.1.0")


@app.on_event("startup")
def _on_startup():
    start_telegram_poller_if_enabled()
_cors_raw = os.getenv("CORS_ORIGINS", "*").strip()
_cors_list = ["*"] if _cors_raw == "*" else [v.strip() for v in _cors_raw.split(",") if v.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_list or ["*"],
    allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE"],
    allow_headers=["Content-Type", "Authorization", "X-Dev-Token", "Idempotency-Key"],
)
api = APIRouter(prefix="/v1")
DB = Depends(get_db)
OWNER = Depends(owner)


@app.middleware("http")
async def private_cache(request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/v1/"):
        response.headers["Cache-Control"] = "private, no-store"
    return response


@app.exception_handler(IntegrityError)
async def conflict(_request, _exc):
    return JSONResponse(status_code=409, content={"detail": "Kode, referensi, atau relasi data telah berubah. Muat ulang."})


@app.get("/health")
def health():
    return {"status": "ok"}


def period(start: date | None, end: date | None, db: Session | None = None, user: str | None = None):
    cutoff = end or datetime.now(JAKARTA).date()
    if start:
        return start, cutoff
    start_day = 1
    if db is not None and user is not None:
        start_day = get_settings(db, user).get("monthly_start_day", 1)
    if start_day == 1:
        return cutoff.replace(day=1), cutoff
    cycle_start, _ = cycle(start_day, cutoff)
    return cycle_start, cutoff


@api.get("/accounts")
def list_accounts(db: Session = DB, user: str = OWNER):
    today = datetime.now(JAKARTA).date()
    result = []
    for account in rows(db, Account, user):
        money = balance(db, account, today)
        reserved = sum(p.remaining for p in active_reserves(db, user, account.id, today))
        result.append(
            {
                **columns(account),
                "balance": money,
                "reserved": reserved,
                "free_balance": money - reserved if money is not None else None,
                "tx_count": account_tx_count(db, user, account.id),
            }
        )
    return result


@api.post("/accounts", status_code=201)
def add_account(data: AccountIn, db: Session = DB, user: str = OWNER):
    obj = Account(owner_id=user, **data.model_dump(exclude={"code"}), code=data.code or str(uuid4()))
    db.add(obj)
    db.commit()
    return {**columns(obj), "balance": balance(db, obj, datetime.now(JAKARTA).date()), "tx_count": 0}


@api.patch("/accounts/{key}")
def update_account_route(key: str, data: AccountEdit, db: Session = DB, user: str = OWNER):
    obj = edit_account(db, user, key, data)
    db.commit()
    return {
        **columns(obj),
        "balance": balance(db, obj, datetime.now(JAKARTA).date()),
        "tx_count": account_tx_count(db, user, obj.id),
    }


@api.delete("/accounts/{key}", status_code=204)
def remove_account_route(
    key: str,
    transfer_to: str | None = None,
    cascade: bool = False,
    db: Session = DB,
    user: str = OWNER,
):
    delete_account(db, user, key, transfer_to=transfer_to, cascade=cascade)
    db.commit()
    return Response(status_code=204)


@api.get("/categories")
def list_categories(db: Session = DB, user: str = OWNER):
    return [columns(c) for c in rows(db, Category, user)]


@api.post("/categories", status_code=201)
def add_category(data: CategoryIn, db: Session = DB, user: str = OWNER):
    if data.parent_id:
        parent = owned(db, Category, user, data.parent_id)
        if parent.kind != data.kind or parent.parent_id or parent.archived:
            fail("Induk harus kategori utama aktif dengan tipe yang sama.")
    obj = Category(owner_id=user, **data.model_dump(exclude={"code"}), code=data.code or str(uuid4()))
    db.add(obj)
    db.commit()
    return columns(obj)


@api.patch("/categories/{key}")
def edit_category(key: str, data: CategoryEdit, db: Session = DB, user: str = OWNER):
    obj = edit_category_item(db, user, key, data)
    db.commit()
    return columns(obj)


@api.delete("/categories/{key}", status_code=204)
def remove_category(key: str, transfer_to: str | None = None, db: Session = DB, user: str = OWNER):
    delete_category(db, user, key, transfer_to=transfer_to)
    db.commit()
    return Response(status_code=204)


@api.get("/transactions")
def list_tx(start: date | None = None, end: date | None = None, db: Session = DB, user: str = OWNER):
    return [transaction_dict(db, tx) for tx in transactions(db, user, start or date.min, end or date.max)]


@api.post("/transactions", status_code=201)
def add_tx(data: TransactionIn, db: Session = DB, user: str = OWNER):
    tx = post_transaction(db, user, data)
    db.commit()
    return transaction_dict(db, tx)


@api.put("/transactions/{key}")
@api.patch("/transactions/{key}")
def edit_tx(key: str, data: TransactionIn, db: Session = DB, user: str = OWNER):
    tx = update_transaction(db, user, key, data)
    db.commit()
    return transaction_dict(db, tx)


@api.delete("/transactions/{key}", status_code=204)
def remove_tx(key: str, db: Session = DB, user: str = OWNER):
    delete_transaction(db, user, key)
    db.commit()
    return Response(status_code=204)


@api.get("/settings")
def read_settings(db: Session = DB, user: str = OWNER):
    return get_settings(db, user)


@api.put("/settings")
def save_settings(data: SettingsIn, db: Session = DB, user: str = OWNER):
    result = update_settings(db, user, data)
    db.commit()
    return result


@api.get("/budgets")
def read_budgets(start: date | None = None, end: date | None = None, db: Session = DB, user: str = OWNER):
    return list_budgets(db, user, *period(start, end, db, user))


@api.post("/budgets", status_code=201)
def save_budget(data: BudgetIn, db: Session = DB, user: str = OWNER):
    result = upsert_budget(db, user, data)
    db.commit()
    return result


@api.delete("/budgets/{key}", status_code=204)
def remove_budget(key: str, db: Session = DB, user: str = OWNER):
    delete_budget(db, user, key)
    db.commit()
    return Response(status_code=204)


@api.get("/summary")
def overview(start: date | None = None, end: date | None = None, db: Session = DB, user: str = OWNER):
    return summary(db, user, *period(start, end, db, user))


@api.get("/reviews")
def reviews(db: Session = DB, user: str = OWNER):
    return [
        columns(i)
        for i in db.scalars(
            select(Evidence)
            .where(Evidence.owner_id == user, Evidence.status == "review")
            .order_by(Evidence.occurred_at.desc())
        )
    ]


@api.get("/connections")
def connections(db: Session = DB, user: str = OWNER):
    latest = dict(
        db.execute(
            select(Evidence.source, func.max(Evidence.received_at))
            .where(Evidence.owner_id == user)
            .group_by(Evidence.source)
        ).all()
    )
    return [{"source": source, "last_received_at": latest.get(source)} for source in ("bca", "gopay", "telegram")]


@api.post("/reviews/{key}/resolve")
def review(key: str, data: ResolveIn, db: Session = DB, user: str = OWNER):
    lock_owner(db, user)
    item = owned(db, Evidence, user, key)
    if item.status != "review":
        return columns(item)
    if data.action == "link":
        if not data.transaction_id:
            fail("Pilih transaksi yang akan ditautkan.")
        item.transaction_id = owned(db, Transaction, user, data.transaction_id).id
        item.status = "linked"
    elif data.action == "post":
        if not data.transaction:
            fail("Lengkapi transaksi sebelum menyimpan.")
        ref = data.transaction.source_ref or item.parsed.get("source_ref") or f"event:{item.id}"
        tx = post_transaction(db, user, data.transaction, item.source, ref)
        item.transaction_id, item.status = tx.id, "posted"
    else:
        item.status = "ignored"
    db.commit()
    return columns(item)


@api.post("/events/{source}")
def event(
    source: Literal["bca", "gopay", "telegram"],
    data: EventIn,
    authorization: str = Header(""),
    db: Session = DB,
):
    if not authorization.startswith("Bearer ") or not secret_matches(authorization[7:], source.upper() + "_TOKEN"):
        raise HTTPException(401, "Kredensial konektor tidak valid.")
    result = ingest(db, configured_owner(), source, data)
    db.commit()
    return {"id": result.id, "status": result.status, "transaction_id": result.transaction_id, "parsed": result.parsed}


@api.get("/goals")
def goals(db: Session = DB, user: str = OWNER):
    totals = dict(
        db.execute(
            select(Reserve.goal_id, func.sum(Reserve.remaining))
            .where(Reserve.owner_id == user, Reserve.goal_id.is_not(None))
            .group_by(Reserve.goal_id)
        ).all()
    )
    return [{**columns(g), "reserved": totals.get(g.id, 0)} for g in rows(db, Goal, user)]


@api.post("/goals", status_code=201)
def create_goal(data: GoalIn, db: Session = DB, user: str = OWNER):
    obj = Goal(owner_id=user, **data.model_dump())
    db.add(obj)
    db.commit()
    return {**columns(obj), "reserved": 0}


@api.get("/schemes")
def schemes(db: Session = DB, user: str = OWNER):
    today = datetime.now(JAKARTA).date()
    result = []
    for scheme in rows(db, Scheme, user):
        totals = db.execute(
            select(Reserve.pot_name, func.sum(Reserve.amount), func.sum(Reserve.remaining))
            .join(Allocation, Allocation.id == Reserve.application_id)
            .where(
                Reserve.scheme_id == scheme.id,
                Allocation.date <= today,
                (Reserve.expires.is_(None)) | (Reserve.expires > today),
            )
            .group_by(Reserve.pot_name)
        ).all()
        result.append(
            {
                **columns(scheme),
                "pots": [
                    {"name": name, "allocated": amount, "used": amount - remaining, "remaining": remaining}
                    for name, amount, remaining in totals
                ],
            }
        )
    return result


@api.post("/schemes", status_code=201)
def create_scheme(data: SchemeIn, db: Session = DB, user: str = OWNER):
    validate_scheme(db, user, data)
    obj = Scheme(owner_id=user, **data.model_dump(exclude={"code"}), code=data.code or str(uuid4()))
    db.add(obj)
    db.commit()
    return columns(obj)


@api.put("/schemes/{key}")
def update_scheme(key: str, data: SchemeIn, db: Session = DB, user: str = OWNER):
    lock_owner(db, user)
    obj = owned(db, Scheme, user, key)
    validate_scheme(db, user, data)
    obj.name, obj.cycle_day, obj.rules = data.name, data.cycle_day, data.model_dump()["rules"]
    db.commit()
    return columns(obj)


@api.post("/schemes/{key}/preview")
def preview(key: str, data: ApplyIn, db: Session = DB, user: str = OWNER):
    return plan_allocation(db, user, key, data)


@api.post("/schemes/{key}/apply")
def apply_scheme(key: str, data: ApplyIn, db: Session = DB, user: str = OWNER):
    result = plan_allocation(db, user, key, data, persist=True)
    db.commit()
    return result


app.include_router(api)
app.include_router(tools_router)
app.include_router(telegram_router)
