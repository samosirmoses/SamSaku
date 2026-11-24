from datetime import date as CalendarDate, datetime, timezone
from uuid import uuid4

from sqlalchemy import BigInteger, Boolean, Date, DateTime, ForeignKey, Integer, JSON, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


def uid():
    return str(uuid4())


def now():
    return datetime.now(timezone.utc)


class Owned:
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner_id: Mapped[str] = mapped_column(String(36), index=True)


class Account(Owned, Base):
    __tablename__ = "accounts"
    __table_args__ = (UniqueConstraint("owner_id", "code"),)
    code: Mapped[str] = mapped_column(String(80))
    name: Mapped[str] = mapped_column(String(160))
    kind: Mapped[str] = mapped_column(String(32), default="wallet")
    currency: Mapped[str] = mapped_column(String(3), default="IDR")
    opening_date: Mapped[CalendarDate | None] = mapped_column(Date)
    opening_balance: Mapped[int | None] = mapped_column(BigInteger)


class Category(Owned, Base):
    __tablename__ = "categories"
    __table_args__ = (UniqueConstraint("owner_id", "code"),)
    code: Mapped[str] = mapped_column(String(80))
    name: Mapped[str] = mapped_column(String(160))
    kind: Mapped[str] = mapped_column(String(12))
    parent_id: Mapped[str | None] = mapped_column(ForeignKey("categories.id"))
    archived: Mapped[bool] = mapped_column(Boolean, default=False)


class Merchant(Owned, Base):
    __tablename__ = "merchants"
    __table_args__ = (UniqueConstraint("owner_id", "code"),)
    code: Mapped[str] = mapped_column(String(80))
    name: Mapped[str] = mapped_column(String(160))


class Alias(Owned, Base):
    __tablename__ = "merchant_aliases"
    __table_args__ = (UniqueConstraint("owner_id", "name"),)
    merchant_id: Mapped[str] = mapped_column(ForeignKey("merchants.id"))
    name: Mapped[str] = mapped_column(String(200))


class Transaction(Owned, Base):
    __tablename__ = "transactions"
    __table_args__ = (UniqueConstraint("owner_id", "source", "source_ref"),)
    date: Mapped[CalendarDate] = mapped_column(Date, index=True)
    kind: Mapped[str] = mapped_column(String(16))
    account_id: Mapped[str] = mapped_column(ForeignKey("accounts.id"))
    to_account_id: Mapped[str | None] = mapped_column(ForeignKey("accounts.id"))
    amount: Mapped[int] = mapped_column(BigInteger)
    fee: Mapped[int] = mapped_column(BigInteger, default=0)
    category_id: Mapped[str | None] = mapped_column(ForeignKey("categories.id"))
    merchant_id: Mapped[str | None] = mapped_column(ForeignKey("merchants.id"))
    original_id: Mapped[str | None] = mapped_column(ForeignKey("transactions.id"))
    description: Mapped[str] = mapped_column(String(500), default="")
    source: Mapped[str] = mapped_column(String(60))
    source_ref: Mapped[str | None] = mapped_column(String(512))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Entry(Owned, Base):
    __tablename__ = "account_entries"
    transaction_id: Mapped[str] = mapped_column(ForeignKey("transactions.id"), index=True)
    account_id: Mapped[str] = mapped_column(ForeignKey("accounts.id"), index=True)
    delta: Mapped[int] = mapped_column(BigInteger)


class Split(Owned, Base):
    __tablename__ = "transaction_allocations"
    transaction_id: Mapped[str] = mapped_column(ForeignKey("transactions.id"), index=True)
    category_id: Mapped[str | None] = mapped_column(ForeignKey("categories.id"))
    amount: Mapped[int] = mapped_column(BigInteger)
    role: Mapped[str] = mapped_column(String(16))


class Evidence(Owned, Base):
    __tablename__ = "source_events"
    __table_args__ = (UniqueConstraint("owner_id", "source", "external_id", "digest"),)
    source: Mapped[str] = mapped_column(String(30))
    external_id: Mapped[str] = mapped_column(String(512))
    digest: Mapped[str] = mapped_column(String(64))
    text: Mapped[str] = mapped_column(Text)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    status: Mapped[str] = mapped_column(String(16), default="review")
    parsed: Mapped[dict] = mapped_column(JSON, default=dict)
    transaction_id: Mapped[str | None] = mapped_column(ForeignKey("transactions.id"))


class Goal(Owned, Base):
    __tablename__ = "goals"
    name: Mapped[str] = mapped_column(String(160))
    target: Mapped[int] = mapped_column(BigInteger)


class Scheme(Owned, Base):
    __tablename__ = "schemes"
    __table_args__ = (UniqueConstraint("owner_id", "code"),)
    code: Mapped[str] = mapped_column(String(80))
    name: Mapped[str] = mapped_column(String(160))
    cycle_day: Mapped[int] = mapped_column(Integer, default=1)
    rules: Mapped[list] = mapped_column(JSON, default=list)


class Allocation(Owned, Base):
    __tablename__ = "scheme_applications"
    __table_args__ = (UniqueConstraint("owner_id", "request_id"),)
    scheme_id: Mapped[str] = mapped_column(ForeignKey("schemes.id"))
    request_id: Mapped[str] = mapped_column(String(100))
    date: Mapped[CalendarDate] = mapped_column(Date)
    cycle_start: Mapped[CalendarDate] = mapped_column(Date)
    snapshot: Mapped[dict] = mapped_column(JSON)


class Reserve(Owned, Base):
    __tablename__ = "reserves"
    application_id: Mapped[str] = mapped_column(ForeignKey("scheme_applications.id"))
    scheme_id: Mapped[str] = mapped_column(ForeignKey("schemes.id"))
    income_id: Mapped[str] = mapped_column(ForeignKey("transactions.id"), index=True)
    account_id: Mapped[str] = mapped_column(ForeignKey("accounts.id"))
    goal_id: Mapped[str | None] = mapped_column(ForeignKey("goals.id"))
    pot_name: Mapped[str] = mapped_column(String(160))
    amount: Mapped[int] = mapped_column(BigInteger)
    remaining: Mapped[int] = mapped_column(BigInteger)
    category_ids: Mapped[list] = mapped_column(JSON, default=list)
    expires: Mapped[CalendarDate | None] = mapped_column(Date)


class ReserveMovement(Owned, Base):
    __tablename__ = "reserve_movements"
    reserve_id: Mapped[str] = mapped_column(ForeignKey("reserves.id"), index=True)
    transaction_id: Mapped[str] = mapped_column(ForeignKey("transactions.id"), index=True)
    category_id: Mapped[str] = mapped_column(ForeignKey("categories.id"))
    amount: Mapped[int] = mapped_column(BigInteger)


class UserSettings(Owned, Base):
    __tablename__ = "user_settings"
    __table_args__ = (UniqueConstraint("owner_id"),)
    monthly_start_day: Mapped[int] = mapped_column(Integer, default=1)
    weekly_start_day: Mapped[int] = mapped_column(Integer, default=1)
    default_account_id: Mapped[str | None] = mapped_column(ForeignKey("accounts.id"), nullable=True)


class Budget(Owned, Base):
    __tablename__ = "budgets"
    __table_args__ = (UniqueConstraint("owner_id", "category_id"),)
    category_id: Mapped[str] = mapped_column(ForeignKey("categories.id"), index=True)
    amount: Mapped[int] = mapped_column(BigInteger)

