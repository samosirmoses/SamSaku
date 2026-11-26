"""Thread-safe native FastAPI WebSocket hub for real-time ledger updates."""
import asyncio
import json
import logging
from collections import defaultdict
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect

from .auth import verify_owner

logger = logging.getLogger("samsaku.realtime")
router = APIRouter()


class RealtimeHub:
    def __init__(self) -> None:
        self._loop: asyncio.AbstractEventLoop | None = None
        self._clients: dict[str, set[WebSocket]] = defaultdict(set)

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def add(self, owner_id: str, ws: WebSocket) -> None:
        self._clients[owner_id].add(ws)

    def remove(self, owner_id: str, ws: WebSocket) -> None:
        sockets = self._clients.get(owner_id)
        if not sockets:
            return
        sockets.discard(ws)
        if not sockets:
            self._clients.pop(owner_id, None)

    async def broadcast(self, owner_id: str, payload: dict) -> None:
        sockets = list(self._clients.get(owner_id) or ())
        if not sockets:
            return
        text = json.dumps(payload, separators=(",", ":"))
        dead: list[WebSocket] = []
        for ws in sockets:
            try:
                await ws.send_text(text)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.remove(owner_id, ws)

    def notify(self, owner_id: str, event: str, message: str = "") -> None:
        if not owner_id or not self._clients.get(owner_id):
            return
        payload = {
            "type": "sync",
            "event": event,
            "message": message,
            "ts": datetime.now(timezone.utc).isoformat(),
        }
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is loop:
            loop.create_task(self.broadcast(owner_id, payload))
        else:
            asyncio.run_coroutine_threadsafe(self.broadcast(owner_id, payload), loop)


hub = RealtimeHub()


def notify(owner_id: str, event: str, message: str = "") -> None:
    try:
        hub.notify(owner_id, event, message)
    except Exception as exc:
        logger.debug("Realtime notify skipped: %s", exc)


@router.websocket("/v1/ws")
async def realtime_ws(ws: WebSocket):
    hub.bind_loop(asyncio.get_running_loop())
    await ws.accept()
    owner_id: str | None = None
    try:
        # Support either query params or first-message auth (first-message keeps tokens out of URL logs)
        q_dev = ws.query_params.get("dev_token", "")
        q_bearer = ws.query_params.get("token", "")
        if q_dev or q_bearer:
            auth_header = f"Bearer {q_bearer}" if q_bearer else ""
            owner_id = verify_owner(authorization=auth_header, x_dev_token=q_dev)
        else:
            raw = await asyncio.wait_for(ws.receive_text(), timeout=10.0)
            msg = json.loads(raw)
            if not isinstance(msg, dict) or msg.get("type") != "auth":
                await ws.close(code=4401)
                return
            token = str(msg.get("token") or "")
            dev_token = str(msg.get("dev_token") or "")
            auth_header = f"Bearer {token}" if token else ""
            owner_id = verify_owner(authorization=auth_header, x_dev_token=dev_token)

        hub.add(owner_id, ws)
        await ws.send_json({"type": "connected"})

        while True:
            try:
                raw = await asyncio.wait_for(ws.receive_text(), timeout=25.0)
            except asyncio.TimeoutError:
                await ws.send_json({"type": "ping"})
                continue
            if raw == "ping":
                await ws.send_text("pong")
                continue
            try:
                msg = json.loads(raw)
                if isinstance(msg, dict) and msg.get("type") == "ping":
                    await ws.send_json({"type": "pong"})
            except ValueError:
                pass
    except (WebSocketDisconnect, asyncio.TimeoutError):
        pass
    except HTTPException:
        try:
            await ws.close(code=4401)
        except Exception:
            pass
    except Exception as exc:
        logger.debug("WebSocket session ended: %s", exc)
    finally:
        if owner_id:
            hub.remove(owner_id, ws)
