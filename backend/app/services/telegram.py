"""Telegram HTTPS webhook handling, instant auto-save, 1-tap inline actions, daily recap, and long-polling bridge."""
import hashlib
import logging
import os
import re
import secrets
import threading
import time
from datetime import date, datetime, timedelta, timezone
from urllib.parse import quote

import httpx
from fastapi import HTTPException
from sqlalchemy import select

from ..core.auth import configured_owner
from ..core.config import JAKARTA, is_test_env
from ..core.db import SessionLocal, lock_owner
from ..core.http_client import get_http_client
from ..core.realtime import notify as realtime_notify
from ..models import Account, Category, Evidence, Transaction
from ..schemas import EventIn, TransactionIn
from .accounts import balance, list_accounts_with_stats
from .calculations import cycle
from .common import owned
from .intake import ingest_with_status
from .jobs import get_job
from .ocr import create_receipt, process_receipt
from .settings import get_settings
from .summary import list_budgets, summary as build_summary
from .transactions import delete_transaction, post_transaction_with_status, splits as tx_splits, update_transaction

MAX_PHOTO = 5 * 1024 * 1024
logger = logging.getLogger("samsaku.telegram")


def _effective_webhook_secret() -> str:
    explicit = (os.environ.get("TELEGRAM_WEBHOOK_SECRET") or "").strip()
    if explicit:
        return explicit
    bot_token = (os.environ.get("TELEGRAM_BOT_TOKEN") or "").strip()
    if bot_token:
        return hashlib.sha256(bot_token.encode()).hexdigest()[:32]
    return ""


def _truthy_env(name: str) -> bool | None:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return None
    val = raw.strip().lower()
    if val in {"1", "true", "yes", "on"}:
        return True
    if val in {"0", "false", "no", "off"}:
        return False
    return None


def telegram_poll_mode() -> str:
    token = (os.environ.get("TELEGRAM_BOT_TOKEN") or "").strip()
    if not token or is_test_env():
        return "disabled"
    public_url = (os.environ.get("RENDER_EXTERNAL_URL") or os.environ.get("PUBLIC_API_URL") or "").strip().rstrip("/")
    has_https_webhook = public_url.startswith("https://")
    poll_flag = _truthy_env("SAMSAKU_TELEGRAM_POLL")
    if has_https_webhook:
        return "webhook"
    if poll_flag is True:
        return "poll"
    return "disabled"


def is_daily_recap_enabled() -> bool:
    return _truthy_env("SAMSAKU_TELEGRAM_DAILY_RECAP") is True


def daily_recap_hour() -> int:
    raw = (os.environ.get("SAMSAKU_TELEGRAM_RECAP_HOUR") or "21").strip()
    try:
        return max(0, min(23, int(raw)))
    except ValueError:
        return 21


def reply(chat_id, text: str, buttons=None, rows: list[list[dict]] | None = None) -> dict:
    result: dict = {"method": "sendMessage", "chat_id": chat_id, "text": text}
    if rows:
        result["reply_markup"] = {"inline_keyboard": rows}
    elif buttons:
        result["reply_markup"] = {"inline_keyboard": [buttons]}
    return result


def download_photo(file_id: str) -> bytes:
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    if not token:
        raise HTTPException(503, "Token bot belum diatur.")
    try:
        http = get_http_client()
        api = f"https://api.telegram.org/bot{token}"
        info = http.post(api + "/getFile", json={"file_id": file_id}, timeout=20)
        info.raise_for_status()
        descriptor = info.json()["result"]
        if descriptor.get("file_size", 0) > MAX_PHOTO:
            raise HTTPException(413, "Ukuran foto melebihi 5 MiB.")
        file_path = quote(descriptor["file_path"], safe="/")
        with http.stream("GET", f"https://api.telegram.org/file/bot{token}/{file_path}", timeout=20) as response:
            response.raise_for_status()
            data = bytearray()
            for chunk in response.iter_bytes(65536):
                data.extend(chunk)
                if len(data) > MAX_PHOTO:
                    raise HTTPException(413, "Ukuran foto melebihi 5 MiB.")
            return bytes(data)
    except (httpx.HTTPError, KeyError, ValueError):
        raise HTTPException(503, "Foto Telegram belum bisa diambil.") from None


def _fmt_rp(amount: int) -> str:
    prefix = "−Rp" if amount < 0 else "Rp"
    return prefix + f"{abs(amount):,}".replace(",", ".")


def _parse_photo_caption(db, owner_id: str, caption: str) -> tuple[str | None, str | None]:
    """Split optional Telegram photo caption into matched wallet id and remaining note text."""
    clean = (caption or "").strip()
    if not clean or clean.lower() == "foto struk":
        return None, None
    accounts = list(db.scalars(select(Account).where(Account.owner_id == owner_id)).all())
    matched = None
    remaining = clean
    for acc in sorted(accounts, key=lambda a: max(len(a.name), len(a.code)), reverse=True):
        for token in (acc.name, acc.code):
            if token and re.search(rf"(?<!\w){re.escape(token)}(?!\w)", remaining, re.I):
                matched = acc
                remaining = re.sub(rf"(?<!\w){re.escape(token)}(?!\w)", " ", remaining, count=1, flags=re.I)
                break
        if matched:
            break
    note = re.sub(r"^[\s\-:,/]+|[\s\-:,/]+$", "", re.sub(r"\s+", " ", remaining)).strip()
    return (matched.id if matched else None), (note or None)


def _prepare_tx_payload(parsed: dict) -> dict:
    kind = parsed.get("kind") or "expense"
    payload = {
        "date": parsed.get("date"),
        "kind": kind,
        "account_id": parsed.get("account_id"),
        "amount": parsed.get("amount"),
        "description": parsed.get("description") or parsed.get("merchant") or "",
    }
    if kind == "transfer":
        payload["to_account_id"] = parsed.get("to_account_id")
        payload["fee"] = int(parsed.get("fee") or 0)
        payload["category_id"] = None
    else:
        payload["category_id"] = parsed.get("category_id")
        payload["to_account_id"] = None
        payload["fee"] = 0
    return payload


def _find_duplicate_candidates(
    db,
    owner_id: str,
    *,
    kind: str,
    account_id: str | None,
    amount: int | None,
    tx_date_iso: str | None,
    window_days: int = 0,
) -> list[dict]:
    if not amount or not tx_date_iso:
        return []
    try:
        day = date.fromisoformat(str(tx_date_iso))
    except ValueError:
        return []
    stmt = select(Transaction).where(
        Transaction.owner_id == owner_id,
        Transaction.kind == kind,
        Transaction.amount == amount,
    )
    if window_days <= 0:
        stmt = stmt.where(Transaction.date == day)
    else:
        stmt = stmt.where(Transaction.date.between(day - timedelta(days=window_days), day + timedelta(days=window_days)))
    if account_id:
        stmt = stmt.where(Transaction.account_id == account_id)
    matches = db.scalars(stmt.limit(10)).all()
    return [
        {"id": x.id, "date": x.date.isoformat(), "description": x.description, "amount": x.amount}
        for x in matches
    ]


def _budget_feedback_line(db, owner_id: str, tx: Transaction, category: Category | None, start_day: int) -> str | None:
    if tx.kind != "expense" or not tx.category_id:
        return None
    c_start, c_next = cycle(start_day, tx.date)
    c_end = c_next - timedelta(days=1)
    budgets = list_budgets(db, owner_id, c_start, c_end)
    target_ids = [tx.category_id]
    if category and category.parent_id:
        target_ids.append(category.parent_id)
    matched = None
    for cid in target_ids:
        matched = next((b for b in budgets if b["category_id"] == cid), None)
        if matched:
            break
    if not matched:
        return None
    rem = int(matched["remaining"])
    pct = int(matched["percent"])
    b_name = matched["category_name"]
    if rem < 0:
        return f"⚠️ Anggaran {b_name} terlampaui {_fmt_rp(abs(rem))} ({pct}%)"
    warn = "⚠️ " if matched["status"] == "warning" else ""
    return f"{warn}Sisa anggaran {b_name}: {_fmt_rp(rem)} ({pct}%)"


def _format_saved_text(db, owner_id: str, tx: Transaction, meta: dict | None = None) -> str:
    meta = meta or {}
    settings = get_settings(db, owner_id)
    today_wib = datetime.now(JAKARTA).date()
    acc = db.scalar(select(Account).where(Account.owner_id == owner_id, Account.id == tx.account_id))
    to_acc = (
        db.scalar(select(Account).where(Account.owner_id == owner_id, Account.id == tx.to_account_id))
        if tx.to_account_id
        else None
    )
    cat = (
        db.scalar(select(Category).where(Category.owner_id == owner_id, Category.id == tx.category_id))
        if tx.category_id
        else None
    )
    tx_type = meta.get("transaction_type")
    engine = meta.get("engine")
    guessed_tag = " (dompet default)" if meta.get("account_guessed") else ""

    if tx.kind == "transfer":
        fee_label = f" (+admin {_fmt_rp(tx.fee)})" if tx.fee > 0 else ""
        route_label = f"{acc.name if acc else '-'} → {to_acc.name if to_acc else '-'}{guessed_tag}"
        header = f"✓ Tercatat · ⇄ Transfer {_fmt_rp(tx.amount)}{fee_label}\n{route_label}"
        meta_parts = [p for p in (tx.date.isoformat(), tx_type) if p]
    elif tx.kind == "income":
        header = f"✓ Tercatat · +{_fmt_rp(tx.amount)} · {acc.name if acc else '-'}{guessed_tag}"
        meta_parts = [p for p in (tx.date.isoformat(), cat.name if cat else None, tx_type) if p]
    else:
        header = f"✓ Tercatat · −{_fmt_rp(tx.amount)} · {acc.name if acc else '-'}{guessed_tag}"
        meta_parts = [p for p in (tx.date.isoformat(), cat.name if cat else None, tx_type) if p]

    lines = [header]
    if meta_parts:
        lines.append(" · ".join(meta_parts))
    if tx.description:
        lines.append(tx.description)
    if engine == "gemini":
        lines.append("(AI Vision)")

    budget_line = _budget_feedback_line(db, owner_id, tx, cat, settings.get("monthly_start_day", 1))
    if budget_line:
        lines.append(budget_line)

    bal_parts = []
    if acc:
        bal = balance(db, acc, today_wib)
        if bal is not None:
            bal_parts.append(f"Saldo {acc.name}: {_fmt_rp(bal)}")
    if to_acc:
        to_bal = balance(db, to_acc, today_wib)
        if to_bal is not None:
            bal_parts.append(f"{to_acc.name}: {_fmt_rp(to_bal)}")
    if bal_parts:
        lines.append(" · ".join(bal_parts))
    return "\n".join(lines)


def _saved_tx_buttons(tx: Transaction) -> list[list[dict]]:
    row = []
    if tx.kind in ("expense", "income"):
        row.append({"text": "Ganti Kategori", "callback_data": f"chcat|{tx.id}"})
    row.append({"text": "Ganti Dompet", "callback_data": f"chacc|{tx.id}"})
    row.append({"text": "Hapus", "callback_data": f"undo|{tx.id}"})
    return [row]


def _build_saved_reply(db, owner_id: str, tx: Transaction, chat_id, meta: dict | None = None) -> dict:
    return reply(chat_id, _format_saved_text(db, owner_id, tx, meta=meta), rows=_saved_tx_buttons(tx))


def _resolve_prefixed(db, model, owner_id: str, prefix: str):
    exact = db.scalar(select(model).where(model.owner_id == owner_id, model.id == prefix))
    if exact:
        return exact
    return db.scalar(select(model).where(model.owner_id == owner_id, model.id.startswith(prefix)).limit(1))


def _tx_to_input(
    db,
    tx: Transaction,
    *,
    account_id: str | None = None,
    category_id: str | None = None,
    replace_category: bool = False,
) -> TransactionIn:
    payload = {
        "date": tx.date,
        "kind": tx.kind,
        "account_id": account_id or tx.account_id,
        "amount": tx.amount,
        "description": tx.description,
        "merchant_id": tx.merchant_id,
        "to_account_id": tx.to_account_id,
        "fee": tx.fee,
        "original_id": tx.original_id,
    }
    if replace_category:
        payload["category_id"] = category_id
        payload["splits"] = []
    else:
        existing_splits = [s for s in tx_splits(db, tx) if s.role != "fee"]
        if len(existing_splits) > 1 and all(s.category_id for s in existing_splits):
            payload["category_id"] = None
            payload["splits"] = [{"category_id": s.category_id, "amount": abs(s.amount)} for s in existing_splits]
        else:
            payload["category_id"] = tx.category_id
            payload["splits"] = []
    return TransactionIn.model_validate(payload)


def confirm(db, owner_id: str, callback: dict, chat_id) -> dict:
    parts = callback.get("data", "").split("|")
    action = parts[0] if parts else ""
    msg_id = (callback.get("message") or {}).get("message_id")

    if action in {"chcat", "chacc", "bk", "undo"} and len(parts) == 2:
        tx_key = parts[1]
        lock_owner(db, owner_id)
        tx = db.scalar(select(Transaction).where(Transaction.owner_id == owner_id, Transaction.id == tx_key))
        if not tx:
            return {"method": "editMessageText", "chat_id": chat_id, "message_id": msg_id, "text": "Transaksi sudah dihapus."}
        if action == "bk":
            return {
                "method": "editMessageText",
                "chat_id": chat_id,
                "message_id": msg_id,
                "text": _format_saved_text(db, owner_id, tx),
                "reply_markup": {"inline_keyboard": _saved_tx_buttons(tx)},
            }
        if action == "undo":
            acc = db.scalar(select(Account).where(Account.owner_id == owner_id, Account.id == tx.account_id))
            to_acc = (
                db.scalar(select(Account).where(Account.owner_id == owner_id, Account.id == tx.to_account_id))
                if tx.to_account_id
                else None
            )
            linked_evs = db.scalars(
                select(Evidence).where(Evidence.owner_id == owner_id, Evidence.transaction_id == tx.id)
            ).all()
            for ev in linked_evs:
                ev.status = "ignored"
                ev.transaction_id = None
            delete_transaction(db, owner_id, tx.id)
            db.commit()
            realtime_notify(owner_id, "telegram:undo", "Transaksi dihapus dari Telegram.")
            today_wib = datetime.now(JAKARTA).date()
            bal_parts = []
            if acc:
                bal = balance(db, acc, today_wib)
                if bal is not None:
                    bal_parts.append(f"Saldo {acc.name}: {_fmt_rp(bal)}")
            if to_acc:
                to_bal = balance(db, to_acc, today_wib)
                if to_bal is not None:
                    bal_parts.append(f"{to_acc.name}: {_fmt_rp(to_bal)}")
            suffix = ("\n" + " · ".join(bal_parts)) if bal_parts else ""
            return {
                "method": "editMessageText",
                "chat_id": chat_id,
                "message_id": msg_id,
                "text": f"🗑️ Transaksi dihapus.{suffix}",
            }
        if action == "chcat":
            wanted = "income" if tx.kind == "income" else "expense"
            cats = list(
                db.scalars(
                    select(Category)
                    .where(Category.owner_id == owner_id, Category.kind == wanted, Category.archived.is_(False))
                    .order_by(Category.name)
                    .limit(8)
                ).all()
            )
            if not cats:
                return {"method": "answerCallbackQuery", "callback_query_id": callback["id"], "text": "Belum ada kategori aktif."}
            keyboard = []
            for idx in range(0, len(cats), 2):
                keyboard.append(
                    [
                        {"text": c.name[:24], "callback_data": f"sc|{tx.id[:24]}|{c.id[:24]}"}
                        for c in cats[idx : idx + 2]
                    ]
                )
            keyboard.append([{"text": "« Kembali", "callback_data": f"bk|{tx.id}"}])
            return {
                "method": "editMessageText",
                "chat_id": chat_id,
                "message_id": msg_id,
                "text": f"Pilih kategori untuk {tx.description or 'transaksi'} ({_fmt_rp(tx.amount)}):",
                "reply_markup": {"inline_keyboard": keyboard},
            }
        if action == "chacc":
            accs = list(
                db.scalars(select(Account).where(Account.owner_id == owner_id).order_by(Account.name).limit(8)).all()
            )
            if tx.kind == "transfer" and tx.to_account_id:
                accs = [a for a in accs if a.id != tx.to_account_id]
            if not accs:
                return {"method": "answerCallbackQuery", "callback_query_id": callback["id"], "text": "Dompet lain belum tersedia."}
            keyboard = []
            for idx in range(0, len(accs), 2):
                keyboard.append(
                    [
                        {"text": a.name[:24], "callback_data": f"sa|{tx.id[:24]}|{a.id[:24]}"}
                        for a in accs[idx : idx + 2]
                    ]
                )
            keyboard.append([{"text": "« Kembali", "callback_data": f"bk|{tx.id}"}])
            return {
                "method": "editMessageText",
                "chat_id": chat_id,
                "message_id": msg_id,
                "text": f"Pilih dompet untuk {tx.description or 'transaksi'} ({_fmt_rp(tx.amount)}):",
                "reply_markup": {"inline_keyboard": keyboard},
            }

    if action in {"sc", "sa"} and len(parts) == 3:
        tx_prefix, target_prefix = parts[1], parts[2]
        lock_owner(db, owner_id)
        tx = _resolve_prefixed(db, Transaction, owner_id, tx_prefix)
        if not tx:
            return {"method": "editMessageText", "chat_id": chat_id, "message_id": msg_id, "text": "Transaksi sudah dihapus."}
        if action == "sc":
            cat = _resolve_prefixed(db, Category, owner_id, target_prefix)
            if not cat:
                return {"method": "answerCallbackQuery", "callback_query_id": callback["id"], "text": "Kategori tidak ditemukan."}
            tx = update_transaction(db, owner_id, tx.id, _tx_to_input(db, tx, category_id=cat.id, replace_category=True))
        else:
            acc = _resolve_prefixed(db, Account, owner_id, target_prefix)
            if not acc:
                return {"method": "answerCallbackQuery", "callback_query_id": callback["id"], "text": "Dompet tidak ditemukan."}
            if tx.kind == "transfer" and tx.to_account_id == acc.id:
                return {"method": "answerCallbackQuery", "callback_query_id": callback["id"], "text": "Dompet asal harus berbeda dari tujuan."}
            tx = update_transaction(db, owner_id, tx.id, _tx_to_input(db, tx, account_id=acc.id))
        db.commit()
        realtime_notify(owner_id, "telegram:updated", "Transaksi Telegram diperbarui.")
        return {
            "method": "editMessageText",
            "chat_id": chat_id,
            "message_id": msg_id,
            "text": _format_saved_text(db, owner_id, tx),
            "reply_markup": {"inline_keyboard": _saved_tx_buttons(tx)},
        }

    if action not in {"save", "cancel"} or len(parts) != 2 or len(parts[1]) != 36:
        return {"method": "answerCallbackQuery", "callback_query_id": callback["id"]}
    key = parts[1]
    lock_owner(db, owner_id)
    item = owned(db, Evidence, owner_id, key)
    if item.source != "telegram" and not (item.source == "receipt" and item.parsed.get("telegram_update")):
        raise HTTPException(404, "Draf tidak ditemukan.")
    saved_tx: Transaction | None = None
    if item.status == "review":
        if action == "cancel":
            item.status = "ignored"
        else:
            parsed = item.parsed or {}
            kind = parsed.get("kind") or "expense"
            transfer_invalid = kind == "transfer" and (
                not parsed.get("to_account_id") or parsed.get("to_account_id") == parsed.get("account_id")
            )
            if not parsed.get("amount") or not parsed.get("account_id") or transfer_invalid or parsed.get("candidates"):
                return reply(chat_id, "Periksa nominal, dompet, dan calon pasangan di Tinjauan SamSaku.")
            data = TransactionIn.model_validate(_prepare_tx_payload(parsed))
            saved_tx, _ = post_transaction_with_status(db, owner_id, data, item.source, item.external_id)
            item.status, item.transaction_id = "posted", saved_tx.id
        if item.source == "receipt":
            job = get_job(db, owner_id, item.external_id, lock=True)
            job.status = "done"
            job.result = {**job.result, "transaction_id": item.transaction_id, "decision": item.status}
        db.commit()
        realtime_notify(owner_id, "telegram:confirm", "Transaksi Telegram diperbarui.")
    if item.status == "ignored":
        return {"method": "editMessageText", "chat_id": chat_id, "message_id": msg_id, "text": "Draf dibatalkan."}
    if saved_tx is None and item.transaction_id:
        saved_tx = db.scalar(select(Transaction).where(Transaction.owner_id == owner_id, Transaction.id == item.transaction_id))
    if saved_tx:
        return {
            "method": "editMessageText",
            "chat_id": chat_id,
            "message_id": msg_id,
            "text": _format_saved_text(db, owner_id, saved_tx, meta=item.parsed),
            "reply_markup": {"inline_keyboard": _saved_tx_buttons(saved_tx)},
        }
    return {
        "method": "editMessageText",
        "chat_id": chat_id,
        "message_id": msg_id,
        "text": "Transaksi sudah diproses di SamSaku.",
    }


def handle_webhook_update(
    update: dict,
    db,
    secret_header: str = "",
    *,
    photo_downloader=None,
) -> dict:
    expected = _effective_webhook_secret()
    if not (
        expected
        and secret_header
        and secrets.compare_digest(secret_header.encode(), expected.encode())
    ):
        raise HTTPException(403, "Webhook tidak dikenali.")
    callback = update.get("callback_query") or {}
    msg = callback.get("message") or update.get("message") or {}
    chat = msg.get("chat", {})
    sender = (callback or msg).get("from", {}).get("id")
    user = os.environ.get("TELEGRAM_USER_ID")
    if not user or chat.get("type") != "private" or str(sender) != user or str(chat.get("id")) != user:
        return {}
    owner_id = configured_owner()
    chat_id = chat["id"]
    if callback:
        return confirm(db, owner_id, callback, chat_id)
    photos = msg.get("photo", [])
    text = (msg.get("text") or msg.get("caption") or "").strip()[:2000]
    if text.startswith("/start") or not (text or photos):
        return reply(chat_id, "Kirim “kopi 35k tunai” atau foto struk dengan nama dompet pada keterangannya.")
    event_text = text or "Foto struk"
    event, created = ingest_with_status(
        db,
        owner_id,
        "telegram",
        EventIn(
            external_id=str(update["update_id"]),
            text=event_text,
            occurred_at=datetime.fromtimestamp(msg["date"], timezone.utc),
        ),
    )
    if not created:
        if event.status == "posted" and event.transaction_id:
            tx = db.scalar(select(Transaction).where(Transaction.owner_id == owner_id, Transaction.id == event.transaction_id))
            db.commit()
            if tx:
                return _build_saved_reply(db, owner_id, tx, chat_id, meta=event.parsed)
        if photos and event.status == "forwarded" and event.parsed.get("receipt_job"):
            receipt_ev = db.scalar(
                select(Evidence).where(
                    Evidence.owner_id == owner_id,
                    Evidence.source == "receipt",
                    Evidence.external_id == event.parsed["receipt_job"],
                )
            )
            if receipt_ev:
                if receipt_ev.status == "posted" and receipt_ev.transaction_id:
                    tx = db.scalar(
                        select(Transaction).where(
                            Transaction.owner_id == owner_id,
                            Transaction.id == receipt_ev.transaction_id,
                        )
                    )
                    db.commit()
                    if tx:
                        return _build_saved_reply(db, owner_id, tx, chat_id, meta=receipt_ev.parsed)
                if receipt_ev.status in ("linked", "ignored"):
                    db.commit()
                    return reply(chat_id, "Bukti ini sudah diproses.")
        elif event.status != "review":
            db.commit()
            return reply(chat_id, "Bukti ini sudah diproses.")

    event_id = event.id
    parsed = dict(event.parsed)
    db.commit()

    downloader = photo_downloader or download_photo
    if photos and not parsed.get("receipt_job"):
        chosen = max(
            (p for p in photos if p.get("file_size", 0) <= MAX_PHOTO),
            key=lambda p: p.get("width", 0),
            default=None,
        )
        if chosen is None:
            return reply(chat_id, "Foto terlalu besar. Kirim ulang foto di bawah 5 MiB.")
        photo_bytes = downloader(chosen["file_id"])
        photo_digest = hashlib.sha256(photo_bytes).hexdigest()
        lock_owner(db, owner_id)
        prior_receipt = db.scalar(
            select(Evidence)
            .where(
                Evidence.owner_id == owner_id,
                Evidence.source == "receipt",
                Evidence.digest == photo_digest,
                Evidence.status.in_(["posted", "linked", "review"]),
            )
            .limit(1)
        )
        event = owned(db, Evidence, owner_id, event_id)
        parsed = dict(event.parsed)
        if prior_receipt:
            if prior_receipt.status in ("posted", "linked") and prior_receipt.transaction_id:
                event.status = "linked"
                event.transaction_id = prior_receipt.transaction_id
                event.parsed = {**parsed, "duplicate_digest": photo_digest, "duplicate_of": prior_receipt.id}
                db.commit()
                return reply(chat_id, "⚠️ Foto struk ini sudah pernah dicatat sebelumnya (duplikat terdeteksi).")
            event.status = "forwarded"
            event.parsed = {**parsed, "duplicate_digest": photo_digest, "duplicate_of": prior_receipt.id}
            db.commit()
            return reply(chat_id, "⚠️ Foto struk yang sama sudah ada di menu Tinjauan.")
        if not parsed.get("receipt_job"):
            job = create_receipt(db, owner_id, "telegram.jpg", photo_bytes)
            parsed["receipt_job"] = job.id
            event.parsed = parsed
        db.commit()

    active_event = event
    if photos:
        caption_account_id, caption_note = _parse_photo_caption(db, owner_id, text)
        db.rollback()
        result = process_receipt(
            db,
            owner_id,
            parsed["receipt_job"],
            caption_account_id=caption_account_id,
            caption_note=caption_note,
        )
        lock_owner(db, owner_id)
        tg_event = owned(db, Evidence, owner_id, event_id)
        tg_event.status = "forwarded"
        active_event = owned(db, Evidence, owner_id, result["evidence_id"])
        if active_event.status == "posted" and active_event.transaction_id:
            tx = db.scalar(select(Transaction).where(Transaction.owner_id == owner_id, Transaction.id == active_event.transaction_id))
            db.commit()
            if tx:
                return _build_saved_reply(db, owner_id, tx, chat_id, meta=active_event.parsed)
        if active_event.status != "review":
            db.commit()
            return reply(chat_id, "Bukti ini sudah diproses.")
        kind = result.get("kind") or "expense"
        acc_id = (
            result.get("account_id")
            or caption_account_id
            or (get_settings(db, owner_id).get("default_account_id") if kind != "transfer" else None)
        )
        parsed = {
            **parsed,
            **active_event.parsed,
            "kind": kind,
            "date": result.get("date") or parsed["date"],
            "account_id": acc_id,
            "to_account_id": result.get("to_account_id") if kind == "transfer" else None,
            "fee": int(result.get("fee") or 0) if kind == "transfer" else 0,
            "category_id": None if kind == "transfer" else result.get("category_id"),
            "category_name": None if kind == "transfer" else result.get("category_name"),
            "telegram_update": str(update["update_id"]),
            "description": result.get("merchant") or event_text,
        }
        if not parsed.get("candidates"):
            parsed["candidates"] = _find_duplicate_candidates(
                db,
                owner_id,
                kind=kind,
                account_id=acc_id,
                amount=parsed.get("amount"),
                tx_date_iso=parsed.get("date"),
                window_days=1,
            )
        active_event.parsed = parsed
        db.commit()
    else:
        kind = parsed.get("kind") or "expense"
        candidates = _find_duplicate_candidates(
            db,
            owner_id,
            kind=kind,
            account_id=parsed.get("account_id"),
            amount=parsed.get("amount"),
            tx_date_iso=parsed.get("date"),
            window_days=0,
        )
        if candidates != (parsed.get("candidates") or []):
            lock_owner(db, owner_id)
            active_event = owned(db, Evidence, owner_id, event_id)
            parsed["candidates"] = candidates
            active_event.parsed = parsed
            db.commit()

    account = db.scalar(select(Account).where(Account.owner_id == owner_id, Account.id == parsed.get("account_id")))
    to_account = (
        db.scalar(select(Account).where(Account.owner_id == owner_id, Account.id == parsed.get("to_account_id")))
        if parsed.get("to_account_id")
        else None
    )
    kind = parsed.get("kind") or "expense"
    amount = parsed.get("amount")
    fee = int(parsed.get("fee") or 0)
    cat_name = parsed.get("category_name")
    tx_type = parsed.get("transaction_type")
    tx_date = parsed.get("date")
    engine = parsed.get("engine")
    transfer_ready = kind != "transfer" or (to_account is not None and account is not None and to_account.id != account.id)
    can_autosave = bool(isinstance(amount, int) and amount > 0 and account is not None and transfer_ready and not parsed.get("candidates"))

    if can_autosave:
        lock_owner(db, owner_id)
        active_event = owned(db, Evidence, owner_id, active_event.id)
        if active_event.status == "review":
            tx_input = TransactionIn.model_validate(_prepare_tx_payload(parsed))
            tx, tx_created = post_transaction_with_status(
                db,
                owner_id,
                tx_input,
                source=active_event.source,
                source_ref=active_event.external_id,
            )
            active_event.status = "posted"
            active_event.transaction_id = tx.id
            active_event.parsed = parsed
            if active_event.source == "receipt":
                job = get_job(db, owner_id, active_event.external_id, lock=True)
                job.status = "done"
                job.result = {**(job.result or {}), "transaction_id": tx.id, "decision": "posted"}
            db.commit()
            if tx_created:
                realtime_notify(owner_id, "telegram:posted", "Transaksi baru tercatat dari Telegram.")
            return _build_saved_reply(db, owner_id, tx, chat_id, meta=parsed)
        if active_event.transaction_id:
            tx = db.scalar(select(Transaction).where(Transaction.owner_id == owner_id, Transaction.id == active_event.transaction_id))
            db.commit()
            if tx:
                return _build_saved_reply(db, owner_id, tx, chat_id, meta=parsed)

    if created:
        realtime_notify(owner_id, "telegram:new", "Draf transaksi baru masuk dari Telegram.")
    guessed_tag = " (dompet perkiraan)" if parsed.get("account_guessed") else ""
    if kind == "transfer":
        amt_label = _fmt_rp(amount) if isinstance(amount, int) else "Periksa nominal"
        fee_label = f" (+admin {_fmt_rp(fee)})" if fee > 0 else ""
        route_label = f"{account.name if account else 'Pilih asal'} → {to_account.name if to_account else 'Pilih tujuan'}{guessed_tag}"
        header = f"⇄ Transfer {amt_label}{fee_label}\n{route_label}"
        meta_parts = [p for p in (tx_date, tx_type) if p]
    elif kind == "income":
        amt_label = f"+{_fmt_rp(amount)}" if isinstance(amount, int) else "Periksa nominal"
        header = f"{amt_label} · {account.name if account else 'Pilih dompet'}{guessed_tag}"
        meta_parts = [p for p in (tx_date, cat_name, tx_type) if p]
    else:
        amt_label = f"−{_fmt_rp(amount)}" if isinstance(amount, int) else "Periksa nominal"
        header = f"{amt_label} · {account.name if account else 'Pilih dompet'}{guessed_tag}"
        meta_parts = [p for p in (tx_date, cat_name, tx_type) if p]

    meta_line = f"\n{' · '.join(meta_parts)}" if meta_parts else ""
    engine_line = "\n(AI Vision)" if engine == "gemini" else ""
    detail = f"{header}{meta_line}\n{parsed.get('description', event_text)}{engine_line}"
    buttons = [{"text": "Batalkan", "callback_data": "cancel|" + active_event.id}]
    if amount and account and transfer_ready and not parsed.get("candidates"):
        buttons.insert(0, {"text": "Simpan", "callback_data": "save|" + active_event.id})
    else:
        reasons = []
        if not amount:
            reasons.append("nominal belum terbaca")
        if not account:
            reasons.append("dompet asal belum terpilih")
        if kind == "transfer" and not transfer_ready:
            reasons.append("dompet asal/tujuan transfer belum lengkap atau sama")
        candidates = parsed.get("candidates") or []
        if candidates:
            c0 = candidates[0]
            reasons.append(
                f"ditemukan {len(candidates)} transaksi mirip ({c0.get('date')} · {c0.get('description') or 'Transaksi'})"
            )
        reason_line = f"Alasan: {'; '.join(reasons)}." if reasons else ""
        detail += f"\n⚠️ {reason_line} Periksa draf di menu Tinjauan."
    return reply(chat_id, detail, buttons)


def build_daily_recap(db, owner_id: str, day: date) -> dict:
    settings = get_settings(db, owner_id)
    day_summary = build_summary(db, owner_id, day, day, settings=settings)
    start_day = settings.get("monthly_start_day", 1)
    c_start, c_next = cycle(start_day, day)
    c_end = c_next - timedelta(days=1)
    cycle_budgets = list_budgets(db, owner_id, c_start, c_end)
    warning_budgets = [b for b in cycle_budgets if b["status"] in ("warning", "over")]
    accounts = list_accounts_with_stats(db, owner_id, day)
    pending_reviews = int(day_summary.get("reviews") or 0)
    tx_count = len(day_summary.get("transactions") or [])

    lines = [
        f"📊 Rekap Harian · {day.isoformat()}",
        f"Transaksi: {tx_count} · Masuk: +{_fmt_rp(day_summary['income'])} · Keluar: −{_fmt_rp(day_summary['expense'])}",
        f"Selisih hari ini: {'+' if day_summary['net'] > 0 else ''}{_fmt_rp(day_summary['net'])}",
    ]
    if warning_budgets:
        top_b = ", ".join(f"{b['category_name']} ({b['percent']}%)" for b in warning_budgets[:3])
        lines.append(f"⚠️ Pantauan anggaran: {top_b}")
    bal_bits = [f"{a['name']} {_fmt_rp(a['balance'])}" for a in accounts if a["balance"] is not None][:4]
    if bal_bits:
        lines.append("Saldo: " + " · ".join(bal_bits))
    if pending_reviews > 0:
        lines.append(f"⏳ {pending_reviews} bukti menunggu di Tinjauan")

    return {
        "date": day.isoformat(),
        "income": day_summary["income"],
        "expense": day_summary["expense"],
        "net": day_summary["net"],
        "tx_count": tx_count,
        "warning_budgets": warning_budgets,
        "pending_reviews": pending_reviews,
        "text": "\n".join(lines),
    }


def maybe_send_daily_recap(
    db,
    owner_id: str,
    *,
    now_dt: datetime | None = None,
    sender=None,
    force: bool = False,
) -> dict:
    current = (now_dt or datetime.now(JAKARTA))
    if current.tzinfo is None:
        current = current.replace(tzinfo=JAKARTA)
    now_wib = current.astimezone(JAKARTA)
    if not force:
        if not is_daily_recap_enabled():
            return {"sent": False, "reason": "disabled"}
        if now_wib.hour < daily_recap_hour():
            return {"sent": False, "reason": "before_schedule"}

    day = now_wib.date()
    marker_id = f"daily-recap:{day.isoformat()}"
    lock_owner(db, owner_id)
    already = db.scalar(
        select(Evidence.id)
        .where(
            Evidence.owner_id == owner_id,
            Evidence.source == "telegram_recap",
            Evidence.external_id == marker_id,
        )
        .limit(1)
    )
    if already:
        db.rollback()
        return {"sent": False, "reason": "already_sent", "date": day.isoformat()}

    recap = build_daily_recap(db, owner_id, day)
    db.rollback()

    chat_id = (os.environ.get("TELEGRAM_USER_ID") or "").strip()
    if sender is not None:
        sender(chat_id or "0", recap["text"])
    else:
        token = (os.environ.get("TELEGRAM_BOT_TOKEN") or "").strip()
        if not token or not chat_id:
            return {"sent": False, "reason": "not_configured", "date": day.isoformat()}
        res = get_http_client().post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            json={"chat_id": chat_id, "text": recap["text"]},
            timeout=15,
        )
        res.raise_for_status()

    lock_owner(db, owner_id)
    again = db.scalar(
        select(Evidence.id)
        .where(
            Evidence.owner_id == owner_id,
            Evidence.source == "telegram_recap",
            Evidence.external_id == marker_id,
        )
        .limit(1)
    )
    if not again:
        db.add(
            Evidence(
                owner_id=owner_id,
                source="telegram_recap",
                external_id=marker_id,
                digest=hashlib.sha256(marker_id.encode()).hexdigest(),
                occurred_at=now_wib.astimezone(timezone.utc),
                text=recap["text"],
                status="posted",
                parsed={
                    "date": day.isoformat(),
                    "tx_count": recap["tx_count"],
                    "income": recap["income"],
                    "expense": recap["expense"],
                },
            )
        )
    db.commit()
    return {"sent": True, "date": day.isoformat(), "text": recap["text"]}


def _poll_once(
    http: httpx.Client,
    api: str,
    secret: str,
    offset: int,
    session_factory=None,
    fail_counts: dict[int, int] | None = None,
    max_retries: int = 5,
    handler=None,
) -> int:
    factory = session_factory or SessionLocal
    counts = fail_counts if fail_counts is not None else {}
    handle = handler or (lambda upd, db, sec: handle_webhook_update(upd, db=db, secret_header=sec))
    res = http.get(f"{api}/getUpdates", params={"timeout": 20, "offset": offset})
    if res.status_code != 200:
        time.sleep(5)
        return offset
    updates = res.json().get("result") or []
    for upd in updates:
        upd_id = int(upd["update_id"])
        try:
            with factory() as db:
                action = handle(upd, db, secret)
            if isinstance(action, dict) and action.get("method"):
                method = action["method"]
                payload = {k: v for k, v in action.items() if k != "method"}
                http.post(f"{api}/{method}", json=payload)
                if upd.get("callback_query") and method != "answerCallbackQuery":
                    http.post(
                        f"{api}/answerCallbackQuery",
                        json={"callback_query_id": upd["callback_query"]["id"]},
                    )
            counts.pop(upd_id, None)
            offset = max(offset, upd_id + 1)
        except Exception as inner_exc:
            logger.warning("Error handling Telegram update %s: %s", upd_id, inner_exc)
            counts[upd_id] = counts.get(upd_id, 0) + 1
            if counts[upd_id] >= max_retries:
                logger.error("Dead-lettering Telegram update %s after %s failures.", upd_id, max_retries)
                counts.pop(upd_id, None)
                offset = max(offset, upd_id + 1)
            else:
                break
    return offset


def _poll_loop() -> None:
    mode = telegram_poll_mode()
    token = (os.environ.get("TELEGRAM_BOT_TOKEN") or "").strip()
    secret = _effective_webhook_secret()
    if mode == "disabled" or not token or not secret:
        return
    api = f"https://api.telegram.org/bot{token}"
    public_url = (os.environ.get("RENDER_EXTERNAL_URL") or os.environ.get("PUBLIC_API_URL") or "").strip().rstrip("/")
    with httpx.Client(timeout=30) as http:
        if mode == "webhook":
            try:
                res = http.post(
                    f"{api}/setWebhook",
                    json={
                        "url": f"{public_url}/v1/webhooks/telegram",
                        "secret_token": secret,
                        "allowed_updates": ["message", "callback_query"],
                    },
                )
                if res.status_code == 200:
                    logger.info("Telegram webhook registered to %s/v1/webhooks/telegram", public_url)
                    return
            except Exception as exc:
                logger.warning("Telegram webhook registration failed: %s", exc)
            return

        try:
            http.post(f"{api}/deleteWebhook", json={"drop_pending_updates": False})
            logger.info("Telegram long-polling active.")
        except Exception as exc:
            logger.warning("Failed to clear Telegram webhook for polling: %s", exc)

        offset = 0
        fail_counts: dict[int, int] = {}
        while True:
            try:
                offset = _poll_once(http, api, secret, offset, fail_counts=fail_counts)
                if is_daily_recap_enabled():
                    try:
                        with SessionLocal() as db:
                            maybe_send_daily_recap(db, configured_owner())
                    except Exception as recap_exc:
                        logger.warning("Daily recap check failed: %s", recap_exc)
            except Exception:
                time.sleep(4)


def start_telegram_poller_if_enabled() -> None:
    if telegram_poll_mode() != "disabled":
        t = threading.Thread(target=_poll_loop, daemon=True, name="telegram-poller")
        t.start()
