"""Telegram HTTPS webhook route."""
from fastapi import APIRouter, Depends, Header

from ..core.db import get_db
from ..services import telegram as telegram_service

router = APIRouter(tags=["telegram"])
download_photo = telegram_service.download_photo
start_telegram_poller_if_enabled = telegram_service.start_telegram_poller_if_enabled


@router.post("/v1/webhooks/telegram")
def receive(update: dict, db=Depends(get_db), x_telegram_bot_api_secret_token: str = Header("")):
    return telegram_service.handle_webhook_update(
        update,
        db=db,
        secret_header=x_telegram_bot_api_secret_token,
        photo_downloader=download_photo,
    )


def _poll_once(http, api: str, secret: str, offset: int, session_factory=None, fail_counts=None, max_retries: int = 5) -> int:
    return telegram_service._poll_once(
        http,
        api,
        secret,
        offset,
        session_factory=session_factory,
        fail_counts=fail_counts,
        max_retries=max_retries,
        handler=lambda upd, db, sec: receive(upd, db=db, x_telegram_bot_api_secret_token=sec),
    )
