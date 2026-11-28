"""Milestone 2 regression tests: Telegram instant auto-save, 1-tap callbacks, daily recap, Excel atomicity & ZIP cap."""
from datetime import date, datetime, timedelta, timezone
from io import BytesIO
from unittest.mock import patch
from zipfile import ZIP_DEFLATED, ZipFile

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from openpyxl import Workbook
from PIL import Image
from sqlalchemy import create_engine, event, func, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core.db import Base, get_db
from app.main import app
from app.models import Account, Budget, Category, Evidence, FileJob, ImportEntry, Transaction
from app.routers import telegram as tg_router
from app.schemas import Commit, ConfirmReceipt, DataResetIn, Preview, SheetMap, TransactionIn
from app.services import imports, ocr
from app.services.accounts import balance
from app.services.jobs import store_file
from app.services.settings import reset_owner_data
from app.services.telegram import maybe_send_daily_recap, telegram_poll_mode
from app.services.transactions import post_transaction
from app.services.xlsx import MAX_UNCOMPRESSED_BYTES, WorkbookError, workbook

OWNER = "00000000-0000-4000-8000-000000000001"
HEADERS = {"X-Dev-Token": "m2-secret"}
WH_HEADERS = {"X-Telegram-Bot-Api-Secret-Token": "tg-sec-m2"}


def _make_engine():
    engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})

    @event.listens_for(engine, "connect")
    def _fk(conn, _rec):
        conn.execute("PRAGMA foreign_keys=ON")

    Base.metadata.create_all(engine)
    return engine


def _png_bytes(color=(255, 255, 255)) -> bytes:
    buf = BytesIO()
    Image.new("RGB", (60, 60), color=color).save(buf, format="PNG")
    return buf.getvalue()


def _xlsx_from_rows(rows: list[list]) -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = "transactions"
    for r in rows:
        ws.append(r)
    out = BytesIO()
    wb.save(out)
    return out.getvalue()


def test_telegram_instant_autosave_budget_feedback_and_inline_callbacks(monkeypatch):
    engine = _make_engine()
    for k, v in {
        "OWNER_ID": OWNER,
        "SAMSAKU_ENV": "development",
        "SAMSAKU_DEV_TOKEN": "m2-secret",
        "TELEGRAM_WEBHOOK_SECRET": "tg-sec-m2",
        "TELEGRAM_USER_ID": "77",
        "GEMINI_API_KEY": "fake-key",
    }.items():
        monkeypatch.setenv(k, v)

    def sessions():
        with Session(engine, expire_on_commit=False) as db:
            yield db

    app.dependency_overrides[get_db] = sessions
    today_ts = int(datetime.now(timezone(timedelta(hours=7))).replace(hour=10, minute=0, second=0, microsecond=0).timestamp())

    try:
        with TestClient(app) as client:
            bca = client.post(
                "/v1/accounts",
                headers=HEADERS,
                json={"name": "BCA", "code": "BCA", "kind": "bank", "opening_date": "2026-01-01", "opening_balance": 1_000_000},
            ).json()
            cash = client.post(
                "/v1/accounts",
                headers=HEADERS,
                json={"name": "Tunai", "code": "CASH", "kind": "cash", "opening_date": "2026-01-01", "opening_balance": 200_000},
            ).json()
            food = client.post("/v1/categories", headers=HEADERS, json={"name": "Makan & Minum", "code": "FOOD", "kind": "expense"}).json()
            trans = client.post("/v1/categories", headers=HEADERS, json={"name": "Transportasi", "code": "TRANS", "kind": "expense"}).json()
            sal = client.post("/v1/categories", headers=HEADERS, json={"name": "Gaji", "code": "SAL", "kind": "income"}).json()

            client.post("/v1/budgets", headers=HEADERS, json={"category_id": food["id"], "amount": 100_000})
            client.put("/v1/settings", headers=HEADERS, json={"monthly_start_day": 1, "weekly_start_day": 1, "default_account_id": cash["id"]})

            # 1. Text expense without explicit wallet -> falls back to default_account_id (Tunai) & auto-saves with budget feedback
            r_exp = client.post(
                "/v1/webhooks/telegram",
                headers=WH_HEADERS,
                json={"update_id": 1001, "message": {"date": today_ts, "from": {"id": 77}, "chat": {"id": 77, "type": "private"}, "text": "kopi 35k"}},
            ).json()
            assert "✓ Tercatat" in r_exp["text"]
            assert "Sisa anggaran Makan & Minum: Rp65.000 (35%)" in r_exp["text"]
            assert "Saldo Tunai: Rp165.000" in r_exp["text"]
            btns = r_exp["reply_markup"]["inline_keyboard"][0]
            assert [b["text"] for b in btns] == ["Ganti Kategori", "Ganti Dompet", "Hapus"]
            assert all(len(b["callback_data"].encode()) <= 64 for b in btns)

            # 2. Repeated update_id=1001 -> idempotent, zero duplicate tx
            r_dup = client.post(
                "/v1/webhooks/telegram",
                headers=WH_HEADERS,
                json={"update_id": 1001, "message": {"date": today_ts, "from": {"id": 77}, "chat": {"id": 77, "type": "private"}, "text": "kopi 35k"}},
            ).json()
            assert r_dup["text"] == r_exp["text"]

            # 3. 1-tap [Ganti Kategori] -> pick Transportasi -> updates category and restores Makan budget
            chcat_cb = {"callback_query": {"id": "cb1", "from": {"id": 77}, "message": {"message_id": 1, "chat": {"id": 77, "type": "private"}}, "data": btns[0]["callback_data"]}}
            cat_menu = client.post("/v1/webhooks/telegram", headers=WH_HEADERS, json=chcat_cb).json()
            trans_btn = next(b for row in cat_menu["reply_markup"]["inline_keyboard"] for b in row if b["text"] == "Transportasi")
            assert len(trans_btn["callback_data"].encode()) <= 64
            picked_cat = client.post(
                "/v1/webhooks/telegram",
                headers=WH_HEADERS,
                json={"callback_query": {"id": "cb2", "from": {"id": 77}, "message": {"message_id": 1, "chat": {"id": 77, "type": "private"}}, "data": trans_btn["callback_data"]}},
            ).json()
            assert "Transportasi" in picked_cat["text"]
            assert "Saldo Tunai: Rp165.000" in picked_cat["text"]

            # 4. 1-tap [Ganti Dompet] -> switch to BCA -> updates both wallet balances
            chacc_btn = next(b for b in picked_cat["reply_markup"]["inline_keyboard"][0] if b["text"] == "Ganti Dompet")
            acc_menu = client.post(
                "/v1/webhooks/telegram",
                headers=WH_HEADERS,
                json={"callback_query": {"id": "cb3", "from": {"id": 77}, "message": {"message_id": 1, "chat": {"id": 77, "type": "private"}}, "data": chacc_btn["callback_data"]}},
            ).json()
            bca_btn = next(b for row in acc_menu["reply_markup"]["inline_keyboard"] for b in row if b["text"] == "BCA")
            picked_acc = client.post(
                "/v1/webhooks/telegram",
                headers=WH_HEADERS,
                json={"callback_query": {"id": "cb4", "from": {"id": 77}, "message": {"message_id": 1, "chat": {"id": 77, "type": "private"}}, "data": bca_btn["callback_data"]}},
            ).json()
            assert "Saldo BCA: Rp965.000" in picked_acc["text"]

            # 5. 1-tap [Hapus] (undo) -> deletes tx, restores BCA balance to Rp1.000.000
            undo_btn = next(b for b in picked_acc["reply_markup"]["inline_keyboard"][0] if b["text"] == "Hapus")
            undone = client.post(
                "/v1/webhooks/telegram",
                headers=WH_HEADERS,
                json={"callback_query": {"id": "cb5", "from": {"id": 77}, "message": {"message_id": 1, "chat": {"id": 77, "type": "private"}}, "data": undo_btn["callback_data"]}},
            ).json()
            assert "Transaksi dihapus" in undone["text"]
            assert "Saldo BCA: Rp1.000.000" in undone["text"]

            # 6. Text income ("gaji 8jt bca") -> auto-saves income & updates BCA balance
            r_inc = client.post(
                "/v1/webhooks/telegram",
                headers=WH_HEADERS,
                json={"update_id": 1002, "message": {"date": today_ts, "from": {"id": 77}, "chat": {"id": 77, "type": "private"}, "text": "gaji 8jt bca"}},
            ).json()
            assert "✓ Tercatat · +Rp8.000.000 · BCA" in r_inc["text"]
            assert sal["name"] in r_inc["text"]
            assert "Saldo BCA: Rp9.000.000" in r_inc["text"]

            # 7. Same-day/amount/wallet duplicate candidate -> routed to reviews with explicit reason
            r_exp2 = client.post(
                "/v1/webhooks/telegram",
                headers=WH_HEADERS,
                json={"update_id": 1003, "message": {"date": today_ts, "from": {"id": 77}, "chat": {"id": 77, "type": "private"}, "text": "makan 45k bca"}},
            ).json()
            assert "✓ Tercatat" in r_exp2["text"]
            r_cand = client.post(
                "/v1/webhooks/telegram",
                headers=WH_HEADERS,
                json={"update_id": 1004, "message": {"date": today_ts, "from": {"id": 77}, "chat": {"id": 77, "type": "private"}, "text": "makan siang 45k bca"}},
            ).json()
            assert "Periksa draf di menu Tinjauan" in r_cand["text"]
            assert "transaksi mirip" in r_cand["text"]

            # 8. Ambiguous amount -> routed to reviews with explicit reason
            r_amb = client.post(
                "/v1/webhooks/telegram",
                headers=WH_HEADERS,
                json={"update_id": 1005, "message": {"date": today_ts, "from": {"id": 77}, "chat": {"id": 77, "type": "private"}, "text": "kopi 35k atau 40k tunai"}},
            ).json()
            assert "nominal belum terbaca" in r_amb["text"]

            # 9. Photo receipt SHA-256 digest dedup: first photo auto-saves, re-sent identical photo is blocked without calling Gemini twice
            img = _png_bytes((12, 34, 56))
            today_iso = datetime.now(timezone(timedelta(hours=7))).date().isoformat()
            fake_ai = {
                "transaction_type": "QRIS",
                "direction": "expense",
                "merchant": "Kopi Tuku",
                "note": None,
                "items": ["Es Kopi"],
                "amount": 28_000,
                "fee": 0,
                "total_amount": 28_000,
                "date": today_iso,
                "category_hint": "Makan & Minum",
                "source_bank": "BCA",
                "engine": "gemini",
                "raw_text": "QRIS Kopi Tuku",
            }
            gemini_calls = 0

            def fake_gemini(*_a, **_kw):
                nonlocal gemini_calls
                gemini_calls += 1
                return fake_ai

            with patch.object(tg_router, "download_photo", return_value=img), patch.object(ocr, "_scan_with_gemini", side_effect=fake_gemini):
                p1 = client.post(
                    "/v1/webhooks/telegram",
                    headers=WH_HEADERS,
                    json={"update_id": 1006, "message": {"date": today_ts, "from": {"id": 77}, "chat": {"id": 77, "type": "private"}, "photo": [{"file_id": "ph1", "width": 800, "file_size": 1024}]}},
                ).json()
                p2 = client.post(
                    "/v1/webhooks/telegram",
                    headers=WH_HEADERS,
                    json={"update_id": 1007, "message": {"date": today_ts, "from": {"id": 77}, "chat": {"id": 77, "type": "private"}, "photo": [{"file_id": "ph2", "width": 800, "file_size": 1024}]}},
                ).json()
            assert "✓ Tercatat" in p1["text"]
            assert "duplikat terdeteksi" in p2["text"]
            assert gemini_calls == 1

            # 10. confirm_receipt_job aligns Evidence.status ("posted" vs "linked")
            with Session(engine) as db:
                j_post = store_file(db, OWNER, "receipt", "a.png", _png_bytes((1, 2, 3)))
                j_link = store_file(db, OWNER, "receipt", "b.png", _png_bytes((4, 5, 6)))
                db.commit()
                jp_id, jl_id = j_post.id, j_link.id
            with patch.object(ocr, "_scan_with_gemini", return_value={**fake_ai, "amount": 19_000, "total_amount": 19_000}):
                client.post(f"/v1/receipts/{jp_id}/process", headers=HEADERS)
                client.post(f"/v1/receipts/{jl_id}/process", headers=HEADERS)
            txs = client.get("/v1/transactions", headers=HEADERS).json()
            c_post = client.post(
                f"/v1/receipts/{jp_id}/confirm",
                headers=HEADERS,
                json={"transaction": {"date": today_iso, "kind": "expense", "account_id": cash["id"], "amount": 19_000, "description": "Snack"}},
            )
            c_link = client.post(
                f"/v1/receipts/{jl_id}/confirm",
                headers=HEADERS,
                json={"transaction_id": txs[0]["id"]},
            )
            assert c_post.status_code == 200 and c_link.status_code == 200
            with Session(engine) as db:
                ev_p = db.scalar(select(Evidence).where(Evidence.external_id == jp_id))
                ev_l = db.scalar(select(Evidence).where(Evidence.external_id == jl_id))
                assert ev_p.status == "posted" and ev_l.status == "linked"
    finally:
        app.dependency_overrides.clear()
        engine.dispose()


def test_excel_atomicity_cross_wallet_refund_content_dedup_zip_bomb_and_storage_purge(monkeypatch):
    engine = _make_engine()

    # 1. ZIP decompression byte cap rejects crafted oversized archive even with spoofed ZipInfo.file_size
    buf = BytesIO()
    with ZipFile(buf, "w", compression=ZIP_DEFLATED) as zf:
        zf.writestr("xl/big.xml", b"A" * (MAX_UNCOMPRESSED_BYTES + 4096))
    raw_zip = bytearray(buf.getvalue())
    # Spoof uncompressed file_size fields in local/central headers by replacing with tiny workbook? Easier: monkeypatch ZipInfo.file_size or patch raw bytes.
    # Replace the 4-byte uncompressed size (0x02001000) in little-endian with 10 bytes (0x0000000a)
    big_len = (MAX_UNCOMPRESSED_BYTES + 4096).to_bytes(4, "little")
    spoof_len = (10).to_bytes(4, "little")
    raw_zip = raw_zip.replace(big_len, spoof_len)
    with ZipFile(BytesIO(bytes(raw_zip))) as check_zf:
        assert sum(i.file_size for i in check_zf.infolist()) == 10
    with pytest.raises(WorkbookError):
        workbook(bytes(raw_zip))

    # 2. Content-hashed row fingerprints + cross-wallet refund + atomic commit rollback
    with Session(engine, expire_on_commit=False) as db:
        bca = Account(id="BCA", owner_id=OWNER, code="BCA", name="BCA", kind="bank", opening_date=date(2026, 1, 1), opening_balance=1_000_000)
        gp = Account(id="GOPAY", owner_id=OWNER, code="GOPAY", name="GoPay", kind="ewallet", opening_date=date(2026, 1, 1), opening_balance=200_000)
        db.add_all([bca, gp])
        db.commit()

        wb1 = _xlsx_from_rows([
            ["date", "kind", "amount", "account", "description", "reference", "original_ref"],
            ["2026-01-05", "expense", 40_000, "BCA", "Makan siang", "", ""],
            ["2026-01-06", "expense", 60_000, "BCA", "Beli barang", "EXP-BCA-1", ""],
            ["2026-01-07", "refund", 25_000, "GOPAY", "Refund ke GoPay", "", "EXP-BCA-1"],
        ])
        job1 = store_file(db, OWNER, "transactions", "u1.xlsx", wb1)
        db.commit()
        plan = Preview(sheets=[SheetMap(name="transactions", entity="transactions")])
        prev1 = imports.preview_import(db, OWNER, job1.id, plan)
        assert prev1["counts"] == {"new": 3}
        res1, changed1 = imports.commit_import(db, OWNER, job1.id, Commit(revision=prev1["revision"]))
        assert changed1 is True and res1["applied"] == 3
        assert balance(db, bca) == 900_000
        assert balance(db, gp) == 225_000

        # Re-upload with row 2 amount edited -> unchanged rows 3 & 4 remain duplicate!
        wb2 = _xlsx_from_rows([
            ["date", "kind", "amount", "account", "description", "reference", "original_ref"],
            ["2026-01-05", "expense", 42_000, "BCA", "Makan siang EDITED", "", ""],
            ["2026-01-06", "expense", 60_000, "BCA", "Beli barang", "EXP-BCA-1", ""],
            ["2026-01-07", "refund", 25_000, "GOPAY", "Refund ke GoPay", "", "EXP-BCA-1"],
        ])
        job2 = store_file(db, OWNER, "transactions", "u2.xlsx", wb2)
        db.commit()
        prev2 = imports.preview_import(db, OWNER, job2.id, plan)
        assert prev2["counts"]["duplicate"] == 2 and prev2["counts"]["new"] == 1

        # Simulate mid-batch DB failure during commit_import -> full rollback, job remains "preview" (not "approved")
        original_evaluate = imports.evaluate
        call_n = {"n": 0}

        def failing_evaluate(*args, **kwargs):
            call_n["n"] += 1
            if kwargs.get("apply"):
                raise RuntimeError("simulated mid-batch crash")
            return original_evaluate(*args, **kwargs)

        with patch.object(imports, "evaluate", side_effect=failing_evaluate):
            with pytest.raises(RuntimeError, match="simulated mid-batch crash"):
                imports.commit_import(db, OWNER, job2.id, Commit(revision=prev2["revision"]))
        reloaded = db.get(FileJob, job2.id)
        assert reloaded.status == "preview"
        assert db.scalar(select(func.count()).select_from(Transaction).where(Transaction.owner_id == OWNER)) == 3
        assert db.scalar(select(func.count()).select_from(ImportEntry).where(ImportEntry.job_id == job2.id)) == 0

        # External storage cleanup on reset_owner_data
        monkeypatch.setenv("FILE_STORAGE_BUCKET", "private-bucket")
        monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
        monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "srv-key")
        db.add(FileJob(id="ext-job-1", owner_id=OWNER, kind="receipt", filename="x.png", digest="d", object_key=f"{OWNER}/ext-job-1"))
        db.commit()
        purged_keys = []
        with patch("app.services.settings.purge_remote_file", side_effect=lambda k: purged_keys.append(k)):
            reset_owner_data(db, OWNER, DataResetIn(mode="partial", confirm="RESET", clear_evidence=True))
        assert purged_keys == [f"{OWNER}/ext-job-1"]
    engine.dispose()


def test_daily_recap_wib_idempotency_and_poll_mode_guard(monkeypatch):
    engine = _make_engine()
    monkeypatch.setenv("SAMSAKU_TELEGRAM_DAILY_RECAP", "1")
    monkeypatch.setenv("SAMSAKU_TELEGRAM_RECAP_HOUR", "21")
    monkeypatch.setenv("TELEGRAM_USER_ID", "77")

    wib = timezone(timedelta(hours=7))
    with Session(engine, expire_on_commit=False) as db:
        db.add(Account(id="BCA", owner_id=OWNER, code="BCA", name="BCA", kind="bank", opening_date=date(2026, 1, 1), opening_balance=500_000))
        db.add(Category(id="FOOD", owner_id=OWNER, code="FOOD", name="Makan", kind="expense"))
        db.flush()
        db.add(Budget(owner_id=OWNER, category_id="FOOD", amount=100_000))
        db.flush()
        post_transaction(db, OWNER, TransactionIn(date=date(2026, 5, 10), kind="expense", account_id="BCA", category_id="FOOD", amount=85_000, description="Makan"))
        db.commit()

        sent = []
        sender = lambda cid, txt: sent.append((cid, txt))

        # Before 21:00 WIB -> does NOT send
        r_early = maybe_send_daily_recap(db, OWNER, now_dt=datetime(2026, 5, 10, 20, 59, tzinfo=wib), sender=sender)
        assert r_early == {"sent": False, "reason": "before_schedule"} and sent == []

        # At 21:00 WIB -> sends once with accurate recap + budget warning
        r_ok = maybe_send_daily_recap(db, OWNER, now_dt=datetime(2026, 5, 10, 21, 0, tzinfo=wib), sender=sender)
        assert r_ok["sent"] is True and len(sent) == 1
        assert "Rekap Harian · 2026-05-10" in sent[0][1]
        assert "Keluar: −Rp85.000" in sent[0][1]
        assert "Makan (85%)" in sent[0][1]

        # Re-run at 21:30 WIB same day -> idempotent, does NOT resend
        r_again = maybe_send_daily_recap(db, OWNER, now_dt=datetime(2026, 5, 10, 21, 30, tzinfo=wib), sender=sender)
        assert r_again["sent"] is False and r_again["reason"] == "already_sent" and len(sent) == 1

        # Next day at 21:05 WIB -> sends for new WIB day
        r_next = maybe_send_daily_recap(db, OWNER, now_dt=datetime(2026, 5, 11, 21, 5, tzinfo=wib), sender=sender)
        assert r_next["sent"] is True and len(sent) == 2

    # SAMSAKU_TELEGRAM_POLL and webhook protection
    monkeypatch.setenv("SAMSAKU_ENV", "production")
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "bot-tok")
    monkeypatch.delenv("PUBLIC_API_URL", raising=False)
    monkeypatch.delenv("RENDER_EXTERNAL_URL", raising=False)

    monkeypatch.setenv("SAMSAKU_TELEGRAM_POLL", "0")
    assert telegram_poll_mode() == "disabled"
    monkeypatch.setenv("SAMSAKU_TELEGRAM_POLL", "1")
    assert telegram_poll_mode() == "poll"
    monkeypatch.setenv("PUBLIC_API_URL", "https://samsaku.example.com")
    assert telegram_poll_mode() == "webhook"
    engine.dispose()
