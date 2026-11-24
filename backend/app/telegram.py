"""Telegram's HTTPS webhook and local development long-polling bridge."""
import logging
import os
import threading
import time
from datetime import datetime, timezone
from urllib.parse import quote

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy import select

from .auth import configured_owner, secret_matches
from .db import SessionLocal, get_db, lock_owner
from .intake import ingest
from .ledger import owned, post_transaction
from .models import Account, Evidence
from .schemas import EventIn, TransactionIn

router = APIRouter()
MAX_PHOTO = 5 * 1024 * 1024
logger = logging.getLogger("samsaku.telegram")


def reply(chat_id, text, buttons=None):
    result = {"method": "sendMessage", "chat_id": chat_id, "text": text}
    if buttons:
        result["reply_markup"] = {"inline_keyboard": [buttons]}
    return result


def download_photo(file_id):
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    if not token:
        raise HTTPException(503, "Token bot belum diatur.")
    try:
        with httpx.Client(timeout=20, follow_redirects=False) as http:
            api = f"https://api.telegram.org/bot{token}"
            info = http.post(api + "/getFile", json={"file_id": file_id})
            info.raise_for_status()
            descriptor = info.json()["result"]
            if descriptor.get("file_size", 0) > MAX_PHOTO:
                raise HTTPException(413, "Ukuran foto melebihi 5 MiB.")
            file_path = quote(descriptor["file_path"], safe="/")
            with http.stream("GET", f"https://api.telegram.org/file/bot{token}/{file_path}") as response:
                response.raise_for_status()
                data = bytearray()
                for chunk in response.iter_bytes(65536):
                    data.extend(chunk)
                    if len(data) > MAX_PHOTO:
                        raise HTTPException(413, "Ukuran foto melebihi 5 MiB.")
                return bytes(data)
    except (httpx.HTTPError, KeyError, ValueError):
        # The upstream URL contains a credential. Keep it out of error messages.
        raise HTTPException(503, "Foto Telegram belum bisa diambil.") from None


def confirm(db, owner_id, callback, chat_id):
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
            from .jobs import get_job
            job = get_job(db, owner_id, item.external_id, lock=True)
            job.status = "done"
            job.result = {**job.result, "transaction_id": item.transaction_id, "decision": item.status}
        db.commit()
    return {"method": "editMessageText", "chat_id": chat_id,
            "message_id": callback["message"]["message_id"],
            "text": "Draf dibatalkan." if item.status == "ignored" else "Transaksi sudah diproses di SamSaku."}


@router.post("/v1/webhooks/telegram")
def receive(update: dict, db=Depends(get_db), x_telegram_bot_api_secret_token: str = Header("")):
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
    event = ingest(db, owner_id, "telegram", EventIn(external_id=str(update["update_id"]),
        text=event_text, occurred_at=datetime.fromtimestamp(msg["date"], timezone.utc)))
    if event.status != "review" and not (photos and event.parsed.get("receipt_job")):
        return reply(chat_id, "Bukti ini sudah diproses.")
    parsed = dict(event.parsed)
    if photos and not parsed.get("receipt_job"):
        from .ocr import create_receipt
        chosen = max((p for p in photos if p.get("file_size", 0) <= MAX_PHOTO),
                     key=lambda p: p.get("width", 0), default=None)
        if chosen is None:
            return reply(chat_id, "Foto terlalu besar. Kirim ulang foto di bawah 5 MiB.")
        job = create_receipt(db, owner_id, "telegram.jpg", download_photo(chosen["file_id"]))
        parsed["receipt_job"] = job.id
        event.parsed = parsed
        # The receipt evidence is the single review item. The envelope is kept
        # for webhook replay and points to the original job.
        event.status = "forwarded"
    db.commit()
    if photos:
        from .ocr import process_receipt
        lock_owner(db, owner_id)
        db.expire_all()
        result = process_receipt(db, owner_id, parsed["receipt_job"])
        lock_owner(db, owner_id)
        db.expire_all()
        event = owned(db, Evidence, owner_id, result["evidence_id"])
        if event.status != "review":
            return reply(chat_id, "Bukti ini sudah diproses.")
        parsed = {**parsed, **event.parsed, "kind": "expense", "date": result.get("date") or parsed["date"],
                  "telegram_update": str(update["update_id"]), "description": result.get("merchant") or event_text}
        event.parsed = parsed
        db.commit()
    account = db.scalar(select(Account).where(Account.owner_id == owner_id, Account.id == parsed.get("account_id")))
    amount = parsed.get("amount")
    value = ("Rp" + f"{amount:,}".replace(",", ".")) if isinstance(amount, int) else "Periksa nominal"
    detail = f"{value} · {account.name if account else 'Pilih dompet'}\n{parsed.get('description', event_text)}"
    buttons = [{"text": "Batalkan", "callback_data": "cancel|" + event.id}]
    if amount and account and not parsed.get("candidates"):
        buttons.insert(0, {"text": "Simpan", "callback_data": "save|" + event.id})
    else:
        detail += "\nPeriksa draf di menu Tinjauan."
    return reply(chat_id, detail, buttons)


def _poll_loop():
    token = (os.environ.get("TELEGRAM_BOT_TOKEN") or "").strip()
    secret = (os.environ.get("TELEGRAM_WEBHOOK_SECRET") or "").strip()
    if not token or not secret:
        return
    api = f"https://api.telegram.org/bot{token}"
    offset = 0
    with httpx.Client(timeout=30) as http:
        try:
            http.post(f"{api}/deleteWebhook", json={"drop_pending_updates": False})
            logger.info("Telegram local long-polling active (no public HTTPS tunnel required).")
        except Exception as exc:
            logger.warning("Failed to clear Telegram webhook for local polling: %s", exc)

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


def start_telegram_poller_if_enabled():
    if os.environ.get("SAMSAKU_TELEGRAM_POLL") == "1" and os.environ.get("TELEGRAM_BOT_TOKEN"):
        t = threading.Thread(target=_poll_loop, daemon=True, name="telegram-poller")
        t.start()

