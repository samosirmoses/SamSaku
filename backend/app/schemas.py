from datetime import date as Date, datetime
from typing import Annotated, Literal

from pydantic import BaseModel, Field, StringConstraints, model_validator

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=160)]
Code = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
Money = Annotated[int, Field(strict=True, gt=0, le=9_000_000_000_000_000)]
Nonnegative = Annotated[int, Field(strict=True, ge=0, le=9_000_000_000_000_000)]


class AccountIn(BaseModel):
    code: Code | None = None
    name: Name
    kind: str = Field(default="wallet", max_length=32)
    opening_date: Date | None = None
    opening_balance: int | None = Field(default=None, ge=-9_000_000_000_000_000, le=9_000_000_000_000_000)

    @model_validator(mode="after")
    def require_anchor(self):
        if (self.opening_date is None) != (self.opening_balance is None):
            raise ValueError("Isi saldo dan tanggal awal bersama-sama.")
        return self


class CategoryIn(BaseModel):
    name: Name
    code: Code | None = None
    kind: Literal["income", "expense"]
    parent_id: str | None = None


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
