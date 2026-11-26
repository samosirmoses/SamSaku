"""Pydantic request schemas for core ledger endpoints."""
import re
from datetime import date as Date, datetime
from typing import Annotated, Literal

from pydantic import BaseModel, Field, StringConstraints, field_validator, model_validator

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=160)]
Code = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
Money = Annotated[int, Field(strict=True, gt=0, le=9_000_000_000_000_000)]
Nonnegative = Annotated[int, Field(strict=True, ge=0, le=9_000_000_000_000_000)]


def _normalize_account_number(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = re.sub(r"[\s.\-]+", "", value.strip())
    if not cleaned:
        return None
    if not cleaned.isdigit() or not (4 <= len(cleaned) <= 24):
        raise ValueError("Nomor rekening / No. HP harus berupa 4–24 digit angka.")
    return cleaned


class AccountIn(BaseModel):
    code: Code | None = None
    name: Name
    kind: str = Field(default="wallet", max_length=32)
    account_number: str | None = Field(default=None, max_length=32)
    opening_date: Date | None = None
    opening_balance: int | None = Field(default=None, ge=-9_000_000_000_000_000, le=9_000_000_000_000_000)

    @field_validator("account_number")
    @classmethod
    def validate_account_number(cls, value: str | None) -> str | None:
        return _normalize_account_number(value)

    @model_validator(mode="after")
    def require_anchor(self):
        if (self.opening_date is None) != (self.opening_balance is None):
            raise ValueError("Isi saldo dan tanggal awal bersama-sama.")
        return self


class AccountEdit(BaseModel):
    code: Code | None = None
    name: Name | None = None
    kind: str | None = Field(default=None, max_length=32)
    account_number: str | None = Field(default=None, max_length=32)
    opening_date: Date | None = None
    opening_balance: int | None = Field(default=None, ge=-9_000_000_000_000_000, le=9_000_000_000_000_000)
    clear_opening: bool = False

    @field_validator("account_number")
    @classmethod
    def validate_account_number(cls, value: str | None) -> str | None:
        return _normalize_account_number(value)

    @model_validator(mode="after")
    def require_anchor(self):
        if not self.clear_opening and (self.opening_date is None) != (self.opening_balance is None):
            raise ValueError("Isi saldo dan tanggal awal bersama-sama.")
        return self


class CategoryIn(BaseModel):
    name: Name
    code: Code | None = None
    kind: Literal["income", "expense"]
    parent_id: str | None = None


class CategoryEdit(BaseModel):
    name: Name | None = None
    kind: Literal["income", "expense"] | None = None
    parent_id: str | None = None
    archived: bool | None = None


class SplitIn(BaseModel):
    category_id: str
    amount: Money


class TransactionIn(BaseModel):
    date: Date
    kind: Literal["income", "expense", "transfer", "refund"]
    account_id: str
    amount: Money
    description: str = Field(default="", max_length=500)
    category_id: str | None = None
    merchant_id: str | None = None
    to_account_id: str | None = None
    fee: Nonnegative = 0
    original_id: str | None = None
    splits: list[SplitIn] = Field(default_factory=list, max_length=100)
    source_ref: str | None = Field(default=None, max_length=512)


class BudgetIn(BaseModel):
    category_id: str
    amount: Money


class SettingsIn(BaseModel):
    monthly_start_day: int = Field(default=1, ge=1, le=31)
    weekly_start_day: int = Field(default=1, ge=0, le=6)
    default_account_id: str | None = None


class RuleIn(BaseModel):
    name: Name
    mode: Literal["fixed", "percent", "remainder"]
    value: Nonnegative = 0
    category_ids: list[str] = Field(default_factory=list, max_length=200)
    goal_id: str | None = None
    rollover: bool = False


class SchemeIn(BaseModel):
    name: Name
    code: Code | None = None
    cycle_day: int = Field(default=1, ge=1, le=31)
    rules: list[RuleIn] = Field(min_length=1, max_length=100)


class ApplyIn(BaseModel):
    income_ids: list[str] = Field(min_length=1, max_length=200)
    request_id: str = Field(min_length=1, max_length=100)
    date: Date
    revision: str | None = Field(default=None, max_length=64)


class GoalIn(BaseModel):
    name: Name
    target: Money


class EventIn(BaseModel):
    external_id: str = Field(min_length=1, max_length=512)
    text: str = Field(min_length=1, max_length=32000)
    occurred_at: datetime | None = None
    metadata: dict = Field(default_factory=dict)


class ResolveIn(BaseModel):
    action: Literal["ignore", "link", "post"]
    transaction_id: str | None = None
    transaction: TransactionIn | None = None
