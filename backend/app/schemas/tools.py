"""Pydantic schemas for Excel import and receipt confirmation endpoints."""
from typing import Literal

from pydantic import BaseModel, Field

from .ledger import TransactionIn


class SheetMap(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    entity: Literal["transactions", "accounts", "categories", "merchants", "aliases", "schemes", "pots"]
    header_row: int = Field(1, ge=1, le=200)
    mapping: dict[str, str] = Field(default_factory=dict, max_length=50)
    date_order: Literal["DMY", "MDY", "YMD"] = "DMY"
    categories: dict[str, str] = Field(default_factory=dict, max_length=1000)
    default_account: str | None = None


class Preview(BaseModel):
    sheets: list[SheetMap] = Field(min_length=1, max_length=40)
    mapping_name: str | None = Field(None, max_length=80)


class RowKey(BaseModel):
    sheet: str
    row: int


class Commit(BaseModel):
    revision: str
    exclude: list[RowKey] = Field(default_factory=list, max_length=10000)
    accept_similar: list[RowKey] = Field(default_factory=list, max_length=10000)


class ConfirmReceipt(BaseModel):
    transaction_id: str | None = None
    transaction: TransactionIn | None = None
