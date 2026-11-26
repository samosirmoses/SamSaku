"""Telegram HTTPS webhook and local/self-hosted long-polling bridge."""
import hashlib
import logging
import os
import threading
import time
from datetime import datetime, timezone
from urllib.parse import quote

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy import select

from ..core.auth import configured_owner, secret_matches
from ..core.config import is_test_env
from ..core.db import SessionLocal, get_db, lock_owner
from ..core.http_client import get_http_client
from ..core.realtime import notify as realtime_notify
from ..models import Account, Evidence
from ..schemas import EventIn, TransactionIn
from ..services.common import owned
from ..services.intake import ingest
from ..services.jobs import get_job
from ..services.ocr import create_receipt, process_receipt
from ..services.settings import get_settings
from ..services.transactions import post_transaction

router = APIRouter(tags=["telegram"])
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


def reply(chat_id, text: str, buttons=None) -> dict:
    result = {"method": "sendMessage", "chat_id": chat_id, "text": text}
    if buttons:
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


def confirm(db, owner_id: str, callback: dict, chat_id) -> dict:
    action, _, key = callback.get("data", "").partition("|")
    if action not in {"save", "cancel"} or len(key) != 36:
        return {"method": "answerCallbackQuery", "callback_query_id": callback["id"]}
    lock_owner(db, owner_id)
    item = owned(db, Evidence, owner_id, key)
    if item.source != "telegram" and not (item.source == "receipt" and item.parsed.get("telegram_update")):
        raise HTTPException(404, "Draf tidak ditemukan.")
    if item.status == "review":
        if action == "cancel":
            item.status = "ignored"
        else:
            parsed = item.parsed or {}
            if not parsed.get("amount") or not parsed.get("account_id") or parsed.get("candidates"):
                return reply(chat_id, "Periksa nominal, dompet, dan calon pasangan di Tinjauan SamSaku.")
            data = TransactionIn.model_validate(parsed)
            tx = post_transaction(db, owner_id, data, item.source, item.external_id)
            item.status, item.transaction_id = "posted", tx.id
        if item.source == "receipt":
            job = get_job(db, owner_id, item.external_id, lock=True)
            job.status = "done"
            job.result = {**job.result, "transaction_id": item.transaction_id, "decision": item.status}
        db.commit()
        realtime_notify(owner_id, "telegram:confirm", "Transaksi Telegram diperbarui.")
    return {
        "method": "editMessageText",
        "chat_id": chat_id,
        "message_id": callback["message"]["message_id"],
        "text": "Draf dibatalkan." if item.status == "ignored" else "Transaksi sudah diproses di SamSaku.",
    }


@router.post("/v1/webhooks/telegram")
def receive(update: dict, db=Depends(get_db), x_telegram_bot_api_secret_token: str = Header("")):
    expected = _effective_webhook_secret()
    if not expected or x_telegram_bot_api_secret_token != expected:
        if not secret_matches(x_telegram_bot_api_secret_token, "TELEGRAM_WEBHOOK_SECRET"):
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
    event = ingest(
        db,
        owner_id,
        "telegram",
        EventIn(
            external_id=str(update["update_id"]),
            text=event_text,
            occurred_at=datetime.fromtimestamp(msg["date"], timezone.utc),
        ),
    )
    if event.status != "review" and not (photos and event.parsed.get("receipt_job")):
        return reply(chat_id, "Bukti ini sudah diproses.")
    parsed = dict(event.parsed)
    if photos and not parsed.get("receipt_job"):
        chosen = max(
            (p for p in photos if p.get("file_size", 0) <= MAX_PHOTO),
            key=lambda p: p.get("width", 0),
            default=None,
        )
        if chosen is None:
            return reply(chat_id, "Foto terlalu besar. Kirim ulang foto di bawah 5 MiB.")
        job = create_receipt(db, owner_id, "telegram.jpg", download_photo(chosen["file_id"]))
        parsed["receipt_job"] = job.id
        event.parsed = parsed
        event.status = "forwarded"
    db.commit()
    if photos:
        lock_owner(db, owner_id)
        db.expire_all()
        result = process_receipt(db, owner_id, parsed["receipt_job"])
        lock_owner(db, owner_id)
        db.expire_all()
        event = owned(db, Evidence, owner_id, result["evidence_id"])
        if event.status != "review":
            return reply(chat_id, "Bukti ini sudah diproses.")
        parsed = {
            **parsed,
            **event.parsed,
            "kind": "expense",
            "date": result.get("date") or parsed["date"],
            "account_id": parsed.get("account_id")
            or result.get("account_id")
            or get_settings(db, owner_id).get("default_account_id"),
            "telegram_update": str(update["update_id"]),
            "description": result.get("merchant") or event_text,
        }
        event.parsed = parsed
        db.commit()
    realtime_notify(owner_id, "telegram:new", "Draf transaksi baru masuk dari Telegram.")
    account = db.scalar(select(Account).where(Account.owner_id == owner_id, Account.id == parsed.get("account_id")))
    amount = parsed.get("amount")
    value = ("Rp" + f"{amount:,}".replace(",", ".")) if isinstance(amount, int) else "Periksa nominal"
    cat_name = parsed.get("category_name")
    tx_date = parsed.get("date")
    engine = parsed.get("engine")
    meta_parts = [p for p in (tx_date, cat_name) if p]
    meta_line = f"\n{' · '.join(meta_parts)}" if meta_parts else ""
    engine_line = "\n(AI Vision)" if engine == "gemini" else ""
    detail = f"{value} · {account.name if account else 'Pilih dompet'}{meta_line}\n{parsed.get('description', event_text)}{engine_line}"
    buttons = [{"text": "Batalkan", "callback_data": "cancel|" + event.id}]
    if amount and account and not parsed.get("candidates"):
        buttons.insert(0, {"text": "Simpan", "callback_data": "save|" + event.id})
    else:
        detail += "\nPeriksa draf di menu Tinjauan."
    return reply(chat_id, detail, buttons)


def _poll_loop() -> None:
    token = (os.environ.get("TELEGRAM_BOT_TOKEN") or "").strip()
    secret = _effective_webhook_secret()
    if not token or not secret:
        return
    api = f"https://api.telegram.org/bot{token}"
    public_url = (os.environ.get("RENDER_EXTERNAL_URL") or os.environ.get("PUBLIC_API_URL") or "").strip().rstrip("/")
    with httpx.Client(timeout=30) as http:
        if public_url.startswith("https://"):
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
                    logger.info("Telegram webhook auto-registered to %s/v1/webhooks/telegram", public_url)
                    return
            except Exception as exc:
                logger.warning("Auto-webhook registration failed, falling back to polling: %s", exc)

        try:
            http.post(f"{api}/deleteWebhook", json={"drop_pending_updates": False})
            logger.info("Telegram long-polling active.")
        except Exception as exc:
            logger.warning("Failed to clear Telegram webhook for polling: %s", exc)

        offset = 0
        while True:
            try:
                res = http.get(f"{api}/getUpdates", params={"timeout": 20, "offset": offset})
                if res.status_code != 200:
                    time.sleep(5)
                    continue
                updates = res.json().get("result") or []
                for upd in updates:
                    offset = max(offset, int(upd["update_id"]) + 1)
                    try:
                        with SessionLocal() as db:
                            action = receive(upd, db=db, x_telegram_bot_api_secret_token=secret)
                        if isinstance(action, dict) and action.get("method"):
                            method = action["method"]
                            payload = {k: v for k, v in action.items() if k != "method"}
                            http.post(f"{api}/{method}", json=payload)
                            if upd.get("callback_query") and method != "answerCallbackQuery":
                                http.post(
                                    f"{api}/answerCallbackQuery",
                                    json={"callback_query_id": upd["callback_query"]["id"]},
                                )
                    except Exception as inner_exc:
                        logger.warning("Error handling Telegram update %s: %s", upd.get("update_id"), inner_exc)
            except Exception:
                time.sleep(4)


def start_telegram_poller_if_enabled() -> None:
    if os.environ.get("TELEGRAM_BOT_TOKEN") and not is_test_env():
        t = threading.Thread(target=_poll_loop, daemon=True, name="telegram-poller")
        t.start()
