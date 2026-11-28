# SamSaku Roadmap (`ROADMAP.md`)

This roadmap defines the phased stabilization and product evolution plan for **SamSaku**, grounded in the technical findings from [`AUDIT.md`](AUDIT.md) and the daily usage loop aligned with [`SPEC.md`](SPEC.md).

> **Execution Rule:** Milestones are strictly sequential. **Milestone 0 must reach 100% Definition of Done before any feature work in Milestone 1+ begins.** Never build new features on top of a fragile ledger.

---

## Target Daily Loop & Scope Discipline

- **Primary Daily Capture (Daytime):** Chat-first via **Telegram** (short text like `"kopi 35k"` or receipt/transfer screenshot via Gemini Vision) → instant auto-save + remaining budget & wallet balance feedback + 1-tap inline correction/undo.
- **Nightly Check-In (Evening):** **Web PWA** → clean Daily / Calendar transaction log, wallet balances, budgets, and spending charts.
- **Periodic Catch-Up:** **Excel `.xlsx` Importer** (bulk BCA/bank statements) + lightweight **CSV** export.
- **Retained Accounting Primitives:** Expense, Income, Transfer, Splits, Refunds, Budgets, and Simple Goals/Envelopes.
- **Frozen / Out-of-Scope for Active Investment:** Android APK (`android/`) and Gmail Apps Script (`connectors/gmail/`) are frozen (existing `/v1/*` contracts remain backward-compatible per [`AGENTS.md`](AGENTS.md)); WeasyPrint A4 PDF and `web/lib/demo.ts` Sandbox are candidates for retirement/slimming in Milestone 3.

---

## Milestone 0 — Stabilization *(Mandatory First Step)*

**Goal:** Eliminate every P0 financial correctness, atomicity, concurrency, and security risk identified in [`AUDIT.md`](AUDIT.md) and enforce core monetary invariants at the database layer.

### Scope
1. **Reserve & Refund Ledger Integrity (`AUDIT.md` P0-1, P0-2):**
   - Reverse `Reserve.remaining` before deleting `ReserveMovement` rows in `update_transaction` and `remove_transaction_records` (`backend/app/services/transactions.py`).
   - Block editing/deleting parent expenses when child `refund` transactions would violate category/amount/date caps, and guard deleting/editing allocated incomes when `Reserve`s exist.
   - Fix `delete_account(..., cascade=True)` FK deletion order (`backend/app/services/accounts.py`) and `delete_category` reserve-movement & JSON `category_ids` handling (`backend/app/services/categories.py`).
   - Block mutating `Category.kind` when referenced by transactions, splits, budgets, schemes, or child categories (`P1-6`).
2. **Financial Math Precision (`AUDIT.md` P0-3, P0-4, P0-5):**
   - Fix `xlsx.money()` (`backend/app/services/xlsx.py`) so comma-grouped amounts like `"1,000"` and `"50,000"` are never silently parsed as 1000x smaller values.
   - Capture currency prefix inside `parser-rules*.json` amount groups so `calculations.rupiah()` parses `"IDR 50000.00"` reliably.
   - Fix `MasterForm.tsx` (`web/features/masters/MasterForm.tsx`) and `format.ts` (`web/lib/format.ts`) so negative opening balances are preserved (not inverted to positive) and unanchored (`null`) wallets are not silently anchored to `Rp 0` on unrelated edits.
3. **Database-Level Invariants (`AUDIT.md` P1-6):**
   - Add Alembic migration (`0006_integrity_constraints.py`) + ORM `CheckConstraint`s on `transactions`, `reserves`, `budgets`, `goals`, and `categories` (`amount > 0`, `fee >= 0`, `remaining >= 0`, `remaining <= amount`, valid `kind` enums, `account_id != to_account_id` on transfers).
4. **Auth, Security & Concurrency Hardening (`AUDIT.md` P0-5, P0-6, P0-7, P0-8):**
   - Replace chained `.*?` `re.DOTALL` regexes in `parser-rules*.json` / `intake.py` with linear-time field extraction to eliminate polynomial ReDoS.
   - Remove WebSocket query-parameter token auth (`?token=` / `?dev_token=`) in `backend/app/core/realtime.py`; enforce first-message auth only.
   - Use `secrets.compare_digest` for Telegram webhook secret verification (`backend/app/routers/telegram.py`), `is_production()`/`app_env()` in `auth.py`/`db.py`, and `x-goog-api-key` header (not URL query param) for Gemini Vision (`backend/app/services/ocr.py`).
   - Decouple external HTTP I/O (Telegram photo download, Supabase Storage fetch, Gemini Vision) from `lock_owner()` and `SELECT ... FOR UPDATE` transactions, and advance Telegram polling `offset` only after commit.
   - Replace bare `crypto.randomUUID()` calls in `web/features/transactions/EntryForm.tsx` with a SecureContext-safe UUIDv4 fallback for HTTP VPS deployments.

### Definition of Done (DoD)
- [x] Unit tests cover **transfer rollback**, **zero-balance & negative opening-balance edge cases**, and double-entry balance reconciliation across edits and deletes.
- [x] Unit tests verify `Reserve.remaining` stays exact across repeated expense/refund edits, expense deletion, cascade account deletion with consumed reserves, and category deletion (with and without `transfer_to`).
- [x] Unit tests verify parent expense edits/deletes are blocked when linked refunds would exceed updated amounts/categories or precede the updated date, and `Category.kind` cannot be flipped once referenced.
- [x] Unit tests verify `xlsx.money()` accurately handles `"1,000"`, `"50,000"`, `"50,000.00"`, `"50.000,00"` and rejects fractional Rupiah (`"1.250,50"`, `"1,234.50"`).
- [x] Alembic migration `0006_integrity_constraints.py` enforces DB `CHECK` constraints, passes `alembic upgrade head` → `alembic downgrade 0005` → `alembic upgrade head` on PostgreSQL, and SQL-level tests confirm invalid writes fail at the database layer.
- [x] Security tests verify: `/v1/ws` rejects query-param tokens, `auth.py` blocks `X-Dev-Token` when `SAMSAKU_ENV=" Production "` and `OWNER_ID` is set, Gemini requests use `x-goog-api-key` header, and 32 KB partial-match BCA text completes in <50 ms (ReDoS regression).
- [x] Concurrency tests verify `process_receipt` and Telegram photo ingestion release DB locks before external HTTP calls and Telegram poller does not drop failed updates.
- [x] Frontend tests/manual verification confirm negative opening balances and unanchored wallets remain intact in `MasterForm`, and transaction creation works over non-HTTPS hosts without `crypto.randomUUID` errors.
- [x] All verification suites pass (`pytest`, `alembic upgrade head`, `ops/export_openapi.py --check`, `npm run typecheck && npm run build`, `sync.test.cjs`) and `docs/DATABASE.md` + `docs/CHANGELOG.md` are updated.

---

## Milestone 1 — Core Daily Loop

**Goal:** Deliver rock-solid transaction CRUD, consistent wallet balances, strict layered architecture boundaries, and a clean, accurate daily/calendar experience across desktop and mobile.

### Scope
1. **Layered Architecture Cleanup (`AUDIT.md` P1-1):**
   - Extract business logic, state machines, and direct ORM queries out of `backend/app/routers/` (`tools.py`, `telegram.py`, `reviews.py`, `bootstrap.py`, `planning.py`, `accounts.py`, `categories.py`) into `backend/app/services/`.
   - Ensure every write service acquires `lock_owner()` before its first read/write (`P1-4` SQLite lock upgrade safety) and never acquires `lock_owner()` on `GET` or read-only preview routes.
   - Add defense-in-depth `owner_id == owner_id` filters on all child-table queries (`P2-2`).
2. **Idempotency & Replay Integrity (`AUDIT.md` P1-3):**
   - Wire the CORS-advertised `Idempotency-Key` header as a fallback `source_ref` on `POST /v1/transactions`.
   - Suppress duplicate `realtime_notify` broadcasts on idempotent transaction/event retries.
   - Return `409 Conflict` when replaying already-completed `/reviews/{key}/resolve`, `/imports/{job_id}/commit`, `/receipts/{job_id}/confirm`, or refund `post_transaction` with conflicting payloads.
3. **Balance & Daily/Calendar View Accuracy (`AUDIT.md` P1-2, P1-5, P2-1):**
   - Validate `month` (`01..12`) in `/v1/bootstrap` to return `422` instead of unhandled `500` on invalid values like `2026-13`.
   - Align `accounts[].balance` and `summary.accounts[].balance` date cutoffs in `/v1/bootstrap` so future-dated transactions never produce conflicting balances in the same payload.
   - Fix `TransactionsView.tsx` and `StatisticsView.tsx` so refunds (`expense(tx) < 0`) are not clamped to `0` per transaction in Calendar and Daily/Weekly charts, and guard `DonutChart.tsx` against negative cross-period category totals.
   - Replace float budget warning math (`int(b.amount * 0.8)`) with exact integer arithmetic (`spent * 5 >= b.amount * 4`).
   - Polish responsive mobile + desktop Daily and Calendar CRUD ergonomics (fast edit, delete confirmation, cycle switching without view reset).

### Definition of Done (DoD)
- [x] Architecture audit confirms zero direct ORM queries (`select()`, `db.add()`, `db.delete()`) or multi-step state machines remain inside `backend/app/routers/`.
- [x] Unit tests cover `Idempotency-Key` header deduplication, `409 Conflict` on mismatched replays (transactions, refunds, reviews, imports, receipts), and zero duplicate WebSocket broadcasts on retry.
- [x] Unit tests cover invalid `month` query params (`2026-00`, `2026-13`) returning HTTP `422`, consistent wallet balances in `/v1/bootstrap` with future-dated transactions, and exact integer 80% budget threshold edge cases.
- [x] Frontend Calendar, Daily, and Weekly totals exactly equal `summary.expense` when refunds, splits, and transfer fees are present, and `DonutChart` renders safely when a category has a net negative cycle total.
- [x] `test_performance.py` passes with O(1) bounded SQL queries across `/v1/accounts`, `/v1/transactions`, and `/v1/bootstrap`, and zero `lock_owner` calls on read-only endpoints.
- [x] `SPEC.md`, `docs/ARCHITECTURE.md`, `docs/API.md`, `docs/openapi.json`, and `docs/CHANGELOG.md` are synced and pass `test_docs_sync.py`.

---

## Milestone 2 — Frictionless Ingestion

**Goal:** Turn Telegram + Gemini Vision into a sub-10-second daily auto-save capture loop and harden Excel `.xlsx` batch ingestion with atomic commits and strict duplicate detection.

### Scope
1. **Telegram Chat-First Instant Auto-Save Loop (`backend/app/services/telegram.py`, `backend/app/routers/telegram.py`):**
   - Auto-save immediately when text (`"kopi 35k"`, `"gaji 8jt bca"`) or Gemini Vision receipt/transfer screenshot resolves clear amount + wallet (falling back to `default_account_id` for non-transfers) and has no duplicate candidate.
   - Reply immediately with transaction summary + **remaining category budget** (if budgeted) + **updated wallet balance**, plus 1-tap inline buttons: `[Ganti Kategori]`, `[Ganti Dompet]`, and `[Hapus]` (undo).
   - Route ambiguous amounts, missing wallets, or detected duplicate candidates cleanly into the `reviews` queue with explicit reasons.
   - Add an optional, idempotent **9 PM (Asia/Jakarta) daily recap** summary sent via Telegram (at most once per day).
   - Respect `SAMSAKU_TELEGRAM_POLL` env flag cleanly (`P2-2`) and prevent webhook deletion when webhook mode is active.
2. **Hardened Excel `.xlsx` Batch Ingestion (`backend/app/services/imports.py`, `xlsx.py`):**
   - Combine approval validation and `imports.evaluate(..., apply=True)` into a single atomic DB transaction so DB/storage errors never leave a job stuck in `"approved"` (`P1-4`).
   - Support cross-wallet refund matching via owner-wide `original_ref` fallback (`P1-3`) and content-hashed row fingerprints for referenceless rows so editing one row does not break deduplication across unchanged rows.
   - Enforce actual streaming decompressed byte limit in `xlsx.workbook()` rather than trusting spoofable ZIP header `file_size` (`P2-2`).
   - Purge external `FILE_STORAGE_BUCKET` objects during `reset_owner_data` and handle failed `purge_file` retries cleanly (`P1-4`).
3. **Strict Cross-Channel Duplicate Detection:**
   - Enforce deterministic deduplication across Telegram `update_id`, receipt image SHA-256 `digest`, explicit provider `source_ref`, and same-day/amount/wallet/kind candidate windows.
   - Align `Evidence.status` (`"posted"` vs `"linked"`) consistently across `reviews`, `telegram`, and `receipts/confirm` (`P2-2`).

### Definition of Done (DoD)
- [x] Automated tests cover Telegram instant auto-save for text & photo (expense, income, transfer with fee), inline `[Ganti Kategori]` / `[Ganti Dompet]` / `[Hapus]` callbacks, and accurate remaining-budget + wallet-balance reply formatting.
- [x] Strict duplicate detection tests cover repeated Telegram `update_id`, re-sent receipt photo digest, same-day/amount/wallet candidate fallback to `reviews`, and Excel re-upload with one edited cell preserving deduplication on unchanged rows.
- [x] Atomicity tests simulate mid-batch failure during Excel commit and verify complete rollback (zero partial transactions and job never stuck in `"approved"`), plus external storage cleanup on `reset_owner_data`.
- [x] Security tests verify ZIP decompression byte cap rejects crafted oversized archives even with spoofed `ZipInfo.file_size`.
- [x] Automated tests cover 9 PM daily recap calculation and idempotent once-per-day delivery in `Asia/Jakarta` timezone.
- [x] `SPEC.md`, `docs/API.md`, `docs/openapi.json`, `docs/VPS_DEPLOYMENT.md`, and `docs/CHANGELOG.md` are synced and all test suites pass.

---

## Milestone 3 — Insights & Polish

**Goal:** Deliver actionable cashflow & budget pacing insights, harden VPS edge security & memory ceilings, modularize large frontend files, and ensure resilient offline/realtime synchronization.

### Scope
1. **Cashflow Analytics, Budget Alerts & Simple Goals:**
   - Cycle pacing indicators (% of budget spent vs % of billing cycle elapsed), safe daily spending allowance, cycle-over-cycle category delta, and simple Goals/Envelopes management UI backed by stabilized `planning.py`.
   - Proactive budget warning alerts (80% warning / 100% exceeded) surfaced both in Telegram auto-save replies and the PWA Dashboard/Budgets view.
2. **VPS Edge Security & Resource Hardening (`AUDIT.md` P1-5, P2-2):**
   - Add security headers (`Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`), `request_body` size limits, and auth/webhook rate limiting to `ops/Caddyfile`.
   - Require explicit `CORS_ORIGINS` in production (`backend/app/core/config.py`) instead of defaulting to `["*"]`.
   - Either bound WeasyPrint PDF rendering with a single-permit concurrency semaphore + date-span/row cap (preventing 384 MB VPS OOMKill) or retire WeasyPrint PDF in favor of lightweight CSV + print stylesheet.
   - Update `ops/backup.py` so restore preserves or re-applies table-level `REVOKE ALL` privilege hardening on PostgreSQL.
   - Add CSV formula-injection escaping (`=`, `+`, `-`, `@`, `\t`, `\r`) to client-side CSV export in `ReportsView.tsx` (or retire `demo.ts` if decided).
3. **Frontend Modularization & Offline/Sync Resilience:**
   - Split oversized frontend components (`web/features/transactions/EntryForm.tsx` and `web/app/page.tsx`) into focused modules (<400 lines each) per [`AGENTS.md`](AGENTS.md) §2.
   - Harden WebSocket reconnection (`useRealtimeSync.ts`) with per-owner socket caps on the server (`realtime.py`), jittered exponential backoff, and automatic missed-event silent reconciliation on reconnect without resetting active Calendar/filter state.
   - Audit Service Worker (`web/public/sw.js`) cache invalidation so static deployments never serve stale JS/CSS bundles after VPS upgrades.

### Definition of Done (DoD)
- [x] Unit tests cover cycle pacing, safe daily allowance, and 80%/100% budget alert triggers across short months (`cycle_day=31` in February), zero-budget, and zero-income edge cases.
- [x] Security & ops tests verify `Caddyfile` security headers & body limits, production `CORS_ORIGINS` enforcement, bounded PDF memory/concurrency (or clean removal with Docker image RAM verification), and `ops/backup.py` save/restore preserving table privilege revocations on PostgreSQL.
- [x] Client-side CSV export tests verify formula-injection payloads (`=SUM(...)`, `+1`, `-1`, `@cmd`) are neutralized identically to backend `safe_cell()`.
- [x] `EntryForm.tsx` and `page.tsx` are decomposed into focused modules (<400 lines each) with zero unused dependencies and passing `npm run typecheck && npm run build`.
- [x] End-to-end sync tests verify WebSocket drop/reconnect triggers silent refresh and updates balances/transactions without losing Calendar view or active filters.
- [x] Full Living Spec (`SPEC.md`, `docs/API.md`, `docs/DATABASE.md`, `docs/ARCHITECTURE.md`, `docs/VPS_DEPLOYMENT.md`, `docs/CHANGELOG.md`, `docs/openapi.json`) is synced and CI (`.github/workflows/verify.yml`) passes cleanly.

---

## Standard Verification Gate (Every Milestone)

Before marking any milestone complete, all applicable checks from [`AGENTS.md`](AGENTS.md) §4 must pass without error:
1. `python -m pytest -q` in `backend/` (including `test_performance.py` and `test_docs_sync.py`)
2. `alembic upgrade head` (and `downgrade` round-trip whenever a migration is added)
3. `python ops/export_openapi.py --check`
4. `npm run typecheck && npm run build` in `web/`
5. `node --test connectors/gmail/tests/sync.test.cjs`
