# SamSaku Repository Audit (`AUDIT.md`)

- **Audit Mode:** Strictly read-only (zero code files modified)
- **Audited Commit:** `ba827f4` (`main`)
- **Scope:** Backend (`backend/app/`, `backend/alembic/`, `backend/parser-rules*.json`), Frontend (`web/`), Connectors (`connectors/gmail/`), Android (`android/`), Ops & Infrastructure (`ops/`, `compose*.yaml`, `Dockerfiles`, `.github/workflows/verify.yml`)
- **Evaluation Axes:** Financial Math Precision · Transaction Atomicity · Idempotency · Layered Architecture Boundaries · Security

---

## Executive Summary

SamSaku has a solid baseline in several critical areas: integer Rupiah storage (`BigInteger` + `Decimal` in XLSX parsing), double-entry `account_entries`, savepoint-isolated Excel preview/commit, batched O(1) read queries (`test_performance.py`), PostgreSQL RLS + `REVOKE ALL` migrations, WeasyPrint subprocess isolation, and Android KeyStore AES-GCM token encryption.

However, the audit identified **8 P0 (Critical / Data & Security Risk)** issues, **6 P1 (Structural)** clusters, and **2 P2 (Cleanup)** clusters. The most severe risks are:
1. **Silent Reserve Pot Corruption & FK Crashes** when editing/deleting transactions, categories, or accounts (`transactions.py`, `accounts.py`, `categories.py`).
2. **1000x Silent Amount Understatement** in Excel import when parsing comma-grouped numbers like `"50,000"` (`xlsx.py`).
3. **Silent Sign Inversion** of negative opening balances when editing wallets in the PWA (`MasterForm.tsx`).
4. **Database Lock & Pool Exhaustion** from holding `pg_advisory_xact_lock` + `FOR UPDATE` across 25–40s external Gemini/Telegram HTTP calls (`ocr.py`, `telegram.py`, `tools.py`).
5. **Polynomial ReDoS & Security Hardening Gaps** in parser rules, WebSocket query-string tokens, non-constant-time Telegram secret verification, and `crypto.randomUUID()` crashing manual entry on HTTP IP deployments.

| Priority | Count | Primary Risk Categories |
| :--- | :---: | :--- |
| **P0 — Critical / Data Risk** | 8 | Reserve/refund data corruption, 1000x XLSX parse bug, UI balance flip, ReDoS, auth/secret leaks, lock-across-HTTP pool exhaustion, HTTP SecureContext crash |
| **P1 — Structural** | 6 | Router/service boundary drift, chart/balance inconsistencies, idempotency replay & lock gaps, PDF OOM / edge security hardening, missing DB `CHECK` constraints |
| **P2 — Cleanup** | 2 | Float threshold/rounding drift, demo CSV sanitization, ZIP size verification, unused env vars, defense-in-depth `owner_id` predicates, component size |

---

## P0 — Critical / Data & Security Risk

### P0-1. Editing or Deleting Transactions, Categories, or Accounts Permanently Corrupts `Reserve.remaining` and Triggers FK Crashes
- **Axes:** Financial Math Precision · Transaction Atomicity
- **References:**
  - `backend/app/services/transactions.py:230-244` (`update_transaction`, especially line 238)
  - `backend/app/services/transactions.py:247-263` (`remove_transaction_records`, lines 258–259)
  - `backend/app/services/accounts.py:237-247` (`delete_account`)
  - `backend/app/services/categories.py:68` (`delete_category`)
- **Mechanics & Impact:**
  1. When an expense or refund is posted (`_write_entries_and_splits`, `backend/app/services/transactions.py:154-173`), `Reserve.remaining` is mutated in-place and recorded in `ReserveMovement` (`+take` for expense, `-take` for refund).
  2. In `update_transaction()` (`backend/app/services/transactions.py:238`), `delete(ReserveMovement).where(ReserveMovement.transaction_id == tx.id)` deletes movement records **without first reversing `reserve.remaining += movement.amount`**, then line 242 re-runs `_write_entries_and_splits()`. Every edit of an expense double-deducts from `Reserve.remaining`; every edit of a refund double-restores it (allowing `remaining > amount`).
  3. In `remove_transaction_records()` (`backend/app/services/transactions.py:258-259`), deleting an expense/refund fails to reverse `Reserve.remaining`, and deleting an allocated income calls `delete(Reserve).where(Reserve.income_id == tx.id)` while `ReserveMovement.reserve_id` rows from other expense transactions still reference those reserves, causing a `409 IntegrityError` FK crash.
  4. In `delete_account(..., cascade=True)` (`backend/app/services/accounts.py:238-240`), iterating `affected` in arbitrary DB order can invoke `remove_transaction_records()` on an allocated income before expenses that consumed its reserve, hitting the same FK crash.
  5. In `delete_category()` (`backend/app/services/categories.py:68`), deleting `ReserveMovement` by `category_id` neither restores `Reserve.remaining` nor rewrites `ReserveMovement.category_id` to `transfer_to`, and leaves deleted `category_id` strings dangling inside JSON `Scheme.rules[*].category_ids` and `Reserve.category_ids`.
- **Recommendation:** Add a single helper `_reverse_reserve_movements(db, tx_id)` that restores `reserve.remaining += movement.amount` before deleting `ReserveMovement` rows in both `update_transaction` and `remove_transaction_records`. Block deleting/cascading an income that has active consumed reserves unless reserves and their `ReserveMovement`s are explicitly unwound first (delete `ReserveMovement` by `reserve_id` before `Reserve`). In `delete_category`, either remap `ReserveMovement.category_id` (when `transfer_to` is provided) or reverse `Reserve.remaining` and prune deleted IDs from `Scheme.rules` and `Reserve.category_ids`.

### P0-2. Editing or Deleting Parent Expenses/Incomes Violates Refund Caps and Allocation Invariants
- **Axes:** Financial Math Precision · Data Integrity
- **References:**
  - `backend/app/services/transactions.py:230-244` (`update_transaction`)
  - `backend/app/services/transactions.py:253-257` (`remove_transaction_records`)
- **Mechanics & Impact:**
  1. `update_transaction()` does not check whether child `refund` rows point to `tx.id` (`Transaction.original_id == tx.id`). An expense of Rp 100,000 with an existing Rp 80,000 refund can be edited down to Rp 10,000, changed to another category/kind (`income`), or moved to a date *after* the refund—producing negative net expenses (`-Rp 70,000`) and violating refund invariants enforced at creation (`refund_portions`, lines 61–105).
  2. Similarly, `update_transaction()` does not check whether `Reserve.income_id == tx.id` exists; an allocated income can be shrunk below its allocated reserve total or changed to `expense` / another account.
  3. `remove_transaction_records()` (`backend/app/services/transactions.py:253-257`) sets `original_id = None` on child refunds when deleting an expense, creating orphaned `kind="refund"` rows that cannot be edited (`refund_portions` line 68 fails) while still deducting negative amounts from category/period expense totals.
- **Recommendation:** Reject `update_transaction()` if child refunds would exceed the updated expense amount/category splits or precede the updated date, and reject edits/deletes of expenses with linked refunds (or incomes with linked reserves) unless child refunds/reserves are removed first.

### P0-3. `xlsx.money()` Silently Understates US Comma-Grouped Amounts by 1000x
- **Axes:** Financial Math Precision
- **References:**
  - `backend/app/services/xlsx.py:130-147` (specifically lines 135–145)
- **Mechanics & Impact:**
  - `money()` validates strings against `r"-?(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d+)?"`, then runs `s.replace(".", "").replace(",", ".")` and checks `Decimal(value) == int(Decimal(value))`.
  - For English/US comma thousands strings common in Indonesian bank exports (e.g., `"50,000"`, `"1,000"`, `"250,000"`): `\d+` matches `"50"` and `(?:,\d+)?` matches `",000"`, transforming `"50,000"` into `Decimal("50.000")`. Because `Decimal("50.000") == 50`, no `ValueError` is raised—**Rp 50,000 is silently imported as Rp 50** (1000x data loss).
- **Recommendation:** Restrict decimal comma fractions to 1–2 digits (`(?:,\d{1,2})?`) for Indonesian format, explicitly reject or parse `r"-?\d{1,3}(?:,\d{3})+(?:\.00)?"` as English thousands separators, and add regression tests for `"1,000"`, `"50,000"`, `"50,000.00"`, and `"50.000,00"`.

### P0-4. `MasterForm` Silently Flips Negative Opening Balances to Positive and Auto-Anchors Unanchored Accounts
- **Axes:** Financial Math Precision · Data Risk
- **References:**
  - `web/features/masters/MasterForm.tsx:29-32`, `:65-76`, `:209-214`
  - `web/lib/format.ts:22-31` (`formatDots`, `parseDigits`)
- **Mechanics & Impact:**
  1. The backend (`AccountIn`/`AccountEdit`, `backend/app/schemas/ledger.py:31`, and Excel import, `backend/app/services/imports.py:105`) supports negative `opening_balance` (e.g., credit cards/liabilities). However, `formatDots()`, `parseDigits()`, and `MasterForm.tsx:211` strip all non-digit characters including `-`. Opening and saving an account with `opening_balance = -500000` silently converts it to **`+500000`** (a Rp 1,000,000 balance error).
  2. If an account has `opening_balance: null` (unanchored), `MasterForm.tsx:29-32` initializes state to `"0"` and `today()`, so editing only the account name or `account_number` silently writes `opening_balance = 0` as of today.
- **Recommendation:** Preserve leading `-` in signed balance formatting/parsing helpers for `MasterForm`, and initialize `openingBalance` to `""` (not `"0"`) and `openingDate` to `""` when `account?.opening_balance == null`.

### P0-5. Polynomial ReDoS in `parser-rules.local.json` and Silent Drop of Ungrouped `IDR <amount>.00` Amounts
- **Axes:** Security (Availability/DoS) · Financial Math Precision
- **References:**
  - `backend/parser-rules.local.json:7`, `:15`
  - `backend/parser-rules.example.json:7`
  - `backend/app/services/intake.py:82`
  - `backend/app/services/calculations.py:7-21`
- **Mechanics & Impact:**
  1. Both BCA regexes chain **6 `.*?` wildcards** with `re.DOTALL` inside `re.fullmatch()` against connector text up to 32,000 bytes (`backend/app/schemas/ledger.py:150`) while holding `lock_owner()`. An email/payload matching the first clauses but omitting `Nomor Referensi` triggers $O(N^5)$ backtracking in Python's `re` engine, saturating CPU and stalling the worker.
  2. The BCA regexes place `(?:IDR|Rp)\.?\s*` *outside* the `(?P<amount>[0-9.,]+)` capture group, so `calculations.rupiah()` receives `"50000.00"` or `"500.00"` with `has_idr = False` (`backend/app/services/calculations.py:9-17`) and returns `None`, silently failing auto-posting for any ungrouped `.00` IDR value.
- **Recommendation:** Replace chained `.*?` `fullmatch()` rules with line-oriented field extraction (or independent anchored `re.search` per field without nested/chained dot-star wildcards), and capture the currency prefix or explicitly accept `.00` in `rupiah()` when paired with IDR/Rp.

### P0-6. Authentication & Secret-Handling Weaknesses (WS Query Tokens, Non-Constant-Time Webhook Check, Case-Sensitive Prod Guard, Unexpiring `localStorage` Admin Token)
- **Axes:** Security
- **References:**
  - `backend/app/core/realtime.py:87-91`
  - `backend/app/routers/telegram.py:158-161`
  - `backend/app/core/auth.py:36-38`
  - `web/lib/api.ts:19-33`
  - `ops/Caddyfile:1-24`
- **Mechanics & Impact:**
  1. `realtime.py:87-91` still accepts `token` and `dev_token` via WebSocket URL query parameters, which leaks bearer/admin secrets into reverse-proxy logs, browser history, and network telemetry (despite `web/hooks/useRealtimeSync.ts:66` using first-message auth).
  2. `telegram.py:159` compares `x_telegram_bot_api_secret_token != expected` using non-constant-time `!=` rather than `secrets.compare_digest`.
  3. `auth.py:36` compares raw `os.getenv("SAMSAKU_ENV") != "production"` (case-sensitive/untrimmed, bypassing `is_production()` in `backend/app/core/config.py:14-15`). In self-hosted mode (`OWNER_ID` empty), a single static, non-expiring `SAMSAKU_DEV_TOKEN` grants full owner + `WIPE SEMUA` privileges, is persisted indefinitely in `localStorage` (`web/lib/api.ts:28`), and has zero brute-force rate limiting in FastAPI or Caddy.
- **Recommendation:** Remove query-parameter token support from `/v1/ws`; replace `!=` in `telegram.py:159` with `secrets.compare_digest`; use `is_production()` in `auth.py:36`; add rate limiting on auth/webhook endpoints; and document HTTPS + `sessionStorage`-only (or short-lived JWT/HttpOnly cookie session exchange) for self-hosted production deployments.

### P0-7. Holding `lock_owner` and Row Locks Across 25–40s External HTTP Calls & Dropping Failed Telegram Polls
- **Axes:** Transaction Atomicity · Availability / Concurrency
- **References:**
  - `backend/app/routers/tools.py:257-260`, `:295-332`
  - `backend/app/services/ocr.py:384-395`
  - `backend/app/routers/telegram.py:178-215`, `:337-352`
  - `backend/app/core/db.py:32-33`
- **Mechanics & Impact:**
  1. `recognize()`, `process_pending()`, `process_receipt()`, and `telegram.receive()` acquire `pg_advisory_xact_lock` (`lock_owner`) and/or `SELECT ... FOR UPDATE` **before** executing synchronous external HTTP calls (`download_photo` up to 40s, Supabase Storage `load_file` up to 30s, Gemini Vision up to 25s). Because `db.py` allocates only `pool_size=4, max_overflow=2` (6 connections total), slow upstream responses block all owner writes and can exhaust the entire PostgreSQL connection pool.
  2. In `telegram.py:199-241`, if `process_receipt()` fails (e.g., Gemini 503) after line 203 commits `event.status = "forwarded"`, the Telegram `Evidence` stays permanently stuck in `"forwarded"` (hidden from `/v1/reviews`), and in polling mode (`telegram.py:338`), `offset` is incremented *before* `receive()` succeeds—permanently dropping failed updates on transient DB/network errors.
- **Recommendation:** Fetch external bytes and call Gemini **outside** any DB transaction / `lock_owner` scope (use a short `processing` lease status, release the DB connection during HTTP I/O, then re-acquire `lock_owner` only for the fast DB write). In `_poll_loop()`, advance `offset` only after `receive()` commits (or after moving unrecoverable payloads to a dead-letter state).

### P0-8. `crypto.randomUUID()` Crashes Manual Transaction Submission on Non-HTTPS VPS Deployments
- **Axes:** Runtime Reliability / Idempotency
- **References:**
  - `web/features/transactions/EntryForm.tsx:279`, `:331`
  - `ops/Caddyfile:1`, `.env.example:5-6`
- **Mechanics & Impact:**
  - `EntryForm.tsx` calls `crypto.randomUUID()` unconditionally to generate `source_ref` on transaction submit. Browsers restrict `crypto.randomUUID` to Secure Contexts (`https://` or `localhost`). When users deploy via the documented HTTP IP option (`SAMSAKU_DOMAIN=:80`), `crypto.randomUUID` is `undefined`, throwing `TypeError: crypto.randomUUID is not a function` and preventing all manual transactions from being saved.
- **Recommendation:** Wrap UUID generation in a helper that uses `crypto.randomUUID()` when available and falls back to `crypto.getRandomValues(new Uint8Array(16))` formatted as UUIDv4.

---

## P1 — Structural

### P1-1. Layered Architecture Violations (`AGENTS.md` §2): Business Logic & ORM Queries in `routers/`
- **Axes:** Layered Architecture Boundaries
- **References:**
  - `backend/app/routers/tools.py:95-206`, `:263-333` (`publish_approved`, `confirm_receipt`, `process_pending`, direct `select(FileJob)`)
  - `backend/app/routers/telegram.py:51-360` (360-line router containing HTTP download, caption NLP, DB queries, confirmation state machine, and background poller thread)
  - `backend/app/routers/reviews.py:20-65` (direct `Evidence` queries, `func.max`, and full `resolve` state machine)
  - `backend/app/routers/bootstrap.py:46-78` (direct `Evidence` queries duplicating `routers/reviews.py`)
  - `backend/app/routers/planning.py:28-56`, `backend/app/routers/accounts.py:32-37`, `backend/app/routers/categories.py:24-33`
- **Mechanics & Impact:** `AGENTS.md` §2 forbids complex queries or business logic in `routers/`. Keeping state machines (`publish_approved`, `confirm_receipt`, `review`, `telegram.confirm`) inside routers causes duplicated queries (`bootstrap.py` vs `reviews.py`), untestable router coupling, and missing `lock_owner` calls on `POST /v1/accounts` and `POST /v1/categories` (creating a TOCTOU race between checking `parent.archived`/`parent.parent_id` and inserting a child category).
- **Recommendation:** Move all domain logic and queries into dedicated services (`services/reviews.py`, `services/telegram.py`, `services/bootstrap.py`, `services/imports.py`, `services/accounts.py`, `services/categories.py`, `services/planning.py`) and ensure every write service invokes `lock_owner` consistently.

### P1-2. Financial Reporting Discrepancies: Refunds Clamped in Charts, Negative Categories in `DonutChart`, and Dual Balance Dates in `/v1/bootstrap`
- **Axes:** Financial Math Precision
- **References:**
  - `web/features/statistics/StatisticsView.tsx:54`, `web/features/transactions/TransactionsView.tsx:152`
  - `backend/app/services/summary.py:162-166`, `:208`, `web/features/statistics/DonutChart.tsx:41-55`
  - `backend/app/routers/bootstrap.py:49`, `backend/app/services/summary.py:200`
- **Mechanics & Impact:**
  1. `StatisticsView.tsx:54` and `TransactionsView.tsx:152` accumulate `Math.max(0, expense(tx))` per transaction, discarding every `refund` (`expense(tx) == -tx.amount`). Consequently, Calendar day totals, Daily/Weekly Cashflow charts, and Day-of-Week charts overstate expenses and disagree with `summary.expense` and the Daily/Weekly list totals (`web/features/transactions/TransactionsView.tsx:138`, `:213`).
  2. When a refund falls in a cycle after its original expense, `summary.py:208` emits a negative category amount (`{"name": ..., "amount": -500000}`), which produces negative SVG `stroke-dasharray` values in `DonutChart.tsx:41-55`.
  3. `/v1/bootstrap` computes top-level `accounts[].balance` as of `today_date` (`bootstrap.py:49`), while `summary.accounts[].balance` is computed as of `period_end` (`summary.py:200`). If any future-dated transaction exists in the current month, the same `/v1/bootstrap` response reports two conflicting balances for the same wallet.
- **Recommendation:** Sum raw `expense(tx)` per day before clamping display height (not per transaction); filter `item.amount > 0` in `DonutChart` (or explicitly display net credit categories separately); and document/align the `as_of` cutoff date across `bootstrap` and `summary`.

### P1-3. Idempotency Gaps, Unused `Idempotency-Key` Header, and Silent Conflicting Replays
- **Axes:** Idempotency
- **References:**
  - `backend/app/main.py:46` vs `backend/app/routers/transactions.py:34-39`
  - `backend/app/services/transactions.py:208-214`
  - `backend/app/routers/reviews.py:48-49`, `:78-81`
  - `backend/app/routers/tools.py:147-148`, `:269-270`
  - `backend/app/services/imports.py:180`, `:186-188`
- **Mechanics & Impact:**
  1. `Idempotency-Key` is whitelisted in CORS `allow_headers` (`main.py:46`), yet no endpoint reads it (`POST /v1/transactions` only inspects `data.source_ref`). Moreover, `POST /v1/transactions` and `POST /v1/events/{source}` still broadcast duplicate `realtime_notify` events on idempotent retries.
  2. In `post_transaction()` (`backend/app/services/transactions.py:208-214`), a refund retry with empty `data.splits` skips split verification against `existing`, allowing differing split payloads on the same `source_ref`.
  3. Replaying `POST /v1/reviews/{key}/resolve`, `POST /v1/imports/{job_id}/commit`, or `POST /v1/receipts/{job_id}/confirm` after completion silently returns `200 OK` even when the caller supplies a different `action`, `exclude`/`accept_similar`, or `transaction_id` (instead of `409 Conflict`).
  4. In `imports.py:180`, rows without a `reference` derive `source_ref` from `file/{job.digest}/{sheet}/{row}`—editing a single cell in a workbook invalidates deduplication for all other rows. And `imports.py:186-188` namespaces `original_ref` under the refund's own `account.id`, breaking cross-account Excel refunds.
- **Recommendation:** Wire `Idempotency-Key` header as fallback `source_ref` on `POST /v1/transactions` (and return `(obj, created)` so retries skip duplicate `realtime_notify`); validate payload equality on resolved/done replays (return `409` on mismatch); and consider content-hashed row keys for referenceless Excel rows plus owner-wide `original_ref` fallback when matching refunds.

### P1-4. Atomicity & Transaction Lifecycle Gaps (`commit` Split-TX, Storage Orphans on Reset, SQLite Lock Upgrade, Write Lock on Preview)
- **Axes:** Transaction Atomicity
- **References:**
  - `backend/app/routers/tools.py:159-192` (`commit` & `publish_approved`)
  - `backend/app/services/settings.py:164-195` (`reset_owner_data`), `backend/app/services/ocr.py:427-431`
  - `backend/app/core/db.py:51-52`
  - `backend/app/routers/planning.py:59-61`, `backend/app/services/planning.py:90-91`
- **Mechanics & Impact:**
  1. `tools.py:159-162` commits `job.status = "approved"` in Transaction 1, releases `lock_owner`, then runs `publish_approved()` in Transaction 2. Unexpected DB/storage exceptions in Transaction 2 leave the job stuck in `"approved"` instead of atomically rolling back.
  2. `reset_owner_data()` (`mode="wipe"` or `clear_evidence=True`) deletes `FileJob` rows without calling `purge_file()`, permanently orphaning private workbooks/receipts in external `FILE_STORAGE_BUCKET` object storage. `ocr.py:427-431` silently swallows `purge_file()` failures without retry scheduling.
  3. On SQLite (`db.py:51-52`), `lock_owner()` skips `BEGIN IMMEDIATE` if a read query already started a `DEFERRED` transaction on the session (e.g., `telegram.py:205-206`), allowing `OperationalError: database is locked` during lock upgrade.
  4. `POST /v1/schemes/{key}/preview` acquires exclusive `lock_owner()` even though `persist=False` is read-only.
- **Recommendation:** Combine approval validation and `imports.evaluate(..., apply=True)` inside one transaction (only persisting `"approved"` for async/deferred execution if explicitly queued); collect external `object_key`s before `FileJob` deletion in `reset_owner_data` and purge them post-commit; avoid calling `lock_owner()` on `persist=False` previews; and always call `lock_owner()` before the first `SELECT` in any write path.

### P1-5. Security, Resource Exhaustion & Operational Hardening (PDF OOM, Edge Headers, CORS, Key in Query, Backup Privileges, 500 on Bad Month, Android Poison Pill)
- **Axes:** Security · Reliability
- **References:**
  - `backend/app/services/reports.py:104-125`, `backend/app/routers/tools.py:227-242`, `compose.prod.yaml:34`
  - `ops/Caddyfile:1-24`, `backend/app/core/config.py:22-27`
  - `backend/app/services/ocr.py:158`
  - `ops/backup.py:35`, `:53-54`
  - `backend/app/routers/bootstrap.py:40-44`, `backend/app/services/settings.py:111-124`
  - `android/app/src/main/java/id/samsaku/capture/SendWorker.kt:18`, `:34-37`
- **Mechanics & Impact:**
  1. **PDF OOM Vector:** `report_pdf()` spawns a new WeasyPrint process per request with no concurrency limit (`threading.BoundedSemaphore(1)`) and no max date span / row cap; 2–3 concurrent PDF downloads inside the `384m` `api` container will trigger OOMKill.
  2. **Missing Security Headers & Default Wildcard CORS:** `ops/Caddyfile` emits no `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, or `request_body { max_size }`. `config.py:23` defaults `CORS_ORIGINS` to `["*"]` even in production.
  3. **API Key in Query String:** `ocr.py:158` passes `GEMINI_API_KEY` via `?key=` URL query param instead of `headers={"x-goog-api-key": api_key}`, increasing secret-leak risk in logs/proxies.
  4. **Backup Restore Strips Table Privilege Revocations:** `ops/backup.py` passes `--no-privileges` to both `pg_dump` and `pg_restore`, dropping the explicit `REVOKE ALL ON TABLE ... FROM PUBLIC/anon/authenticated` statements applied by migrations `0001`–`0003` (RLS remains enabled, but role-level revocations are lost on restore).
  5. **Unhandled 500 on Invalid `month`:** `bootstrap.py:40` matches `\d{4}-\d{2}` without checking `01 <= mm <= 12`; `GET /v1/bootstrap?month=2026-13` raises unhandled `ValueError` (HTTP 500).
  6. **Android Outbox Head-of-Line Blocking:** In `SendWorker.kt:18,34-37`, any permanent `4xx` response (e.g., `422`) returns `Result.failure()` without quarantining/dropping the offending row from `pending_events`, permanently stalling delivery of all subsequent notifications.
- **Recommendation:** Guard `report_pdf` with a single-permit semaphore + max row/span cap; add standard security headers & body limits to `Caddyfile` and require explicit `CORS_ORIGINS` in production; switch Gemini auth to `x-goog-api-key` header; re-apply `REVOKE ALL` (or omit `--no-privileges` for self-hosted Postgres) in `backup.py`; validate `1 <= month <= 12` in `bootstrap.py`; and quarantine/drop non-auth `4xx` (`400`/`422`) poison-pill items in `SendWorker.kt` (while still pausing on `401`/`403`).

### P1-6. Category Kind Mutation Corruption & Missing Database-Level `CHECK` Constraints
- **Axes:** Data Integrity · Schema Design
- **References:**
  - `backend/app/services/categories.py:11-37` (`edit_category_item`)
  - `backend/app/models/ledger.py:72-189`, `backend/alembic/versions/0001_core.py:43-75`
- **Mechanics & Impact:**
  1. `edit_category_item()` permits changing `Category.kind` (`expense` ↔ `income`) even when transactions, splits, budgets, schemes, or subcategories already reference that category (in contrast to `imports.py:97-98`, which rejects master kind changes).
  2. None of the core ledger tables enforce DB-level `CheckConstraint`s (`amount > 0`, `fee >= 0`, `remaining >= 0`, `remaining <= amount`, valid `kind` values, `account_id != to_account_id` for transfers), leaving financial integrity wholly dependent on every application code path.
- **Recommendation:** Forbid changing `Category.kind` when referenced by child categories, transactions, splits, budgets, or schemes (or disallow `kind` mutation entirely via `CategoryEdit`). Add an Alembic migration adding DB-level `CHECK` constraints for core monetary and relational invariants.

---

## P2 — Cleanup & Defense-in-Depth

### P2-1. Minor Financial Math & Parsing Edge Cases
- **Budget Warning Float Arithmetic & Rounding Drift:** `backend/app/services/summary.py:59-60` computes `spent >= int(b.amount * 0.8)` using float multiplication (use exact integer `spent * 5 >= b.amount * 4`), and Python `round()` (round-half-to-even) diverges slightly from JS `Math.round()` in `web/lib/demo.ts:241-243`.
- **Schema Strictness & JS Safe Integer Headroom:** `opening_balance` in `backend/app/schemas/ledger.py:31`, `:51` lacks `strict=True` (unlike `Money`/`Nonnegative`). `Money` upper bound (`9_000_000_000_000_000`) sits right below JS `Number.MAX_SAFE_INTEGER` (`9_007_199_254_740_991`), so summing two max-bound entries in JS (`web/lib/format.ts:28-31`) loses precision; capping single transactions lower (e.g., `1_000_000_000_000_000`) preserves safe JS aggregation headroom.
- **`rupiah()` Dotted Prefix & `balance()` Null Guard:** `backend/app/services/calculations.py:10` does not strip `"rp."` (e.g., `"Rp. 50.000"` returns `None`), and `backend/app/services/accounts.py:40` uses `account.opening_balance + ...` without the `(acc.opening_balance or 0)` defensive guard present in `batch_balances()` (line 74).

### P2-2. Security Hygiene, Operational Cleanup & Code Organization
- **Client-Side Demo CSV Formula Escaping:** `web/features/reports/ReportsView.tsx:78-103` exports CSV in `demoMode` without formula-injection sanitization (`=`, `+`, `-`, `@`, `\t`, `\r`), unlike backend `safe_cell()` (`backend/app/services/reports.py:33-36`).
- **ZIP Bomb Decompression Accounting:** `backend/app/services/xlsx.py:72` relies solely on `ZipInfo.file_size` from the ZIP header (which can be spoofed in crafted archives) rather than bounding actual decompressed bytes read.
- **Inconsistent `Evidence.status` on Receipt Confirmation:** `backend/app/routers/tools.py:282` sets `evidence.status = "linked"` even when posting a new transaction (whereas `backend/app/routers/reviews.py:60` and `backend/app/routers/telegram.py:141` set `"posted"`).
- **Dead `SAMSAKU_TELEGRAM_POLL` Env Var & Multi-Worker Risk:** `compose.yaml:21` sets `SAMSAKU_TELEGRAM_POLL: "1"`, but `backend/app/routers/telegram.py:357-360` ignores it and always spawns `_poll_loop` when `TELEGRAM_BOT_TOKEN` is set (which can also delete manually configured webhooks if `PUBLIC_API_URL` isn't set, or race if `uvicorn --workers > 1`).
- **Centralize `SAMSAKU_ENV` Helpers:** `backend/app/core/db.py:20` and `backend/app/core/auth.py:36` read raw `os.getenv("SAMSAKU_ENV")` instead of `app_env()` / `is_production()` from `backend/app/core/config.py:10-15`.
- **Defense-in-Depth `owner_id` Filtering on Child Queries:** Child-table queries in `backend/app/services/transactions.py:17`, `:22-30`, `:74-86`, `:236-238`, `:258-261`, `:290`, `backend/app/services/planning.py:125`, `backend/app/services/accounts.py:205-206`, `:217-220`, `:227-230`, and `backend/app/services/imports.py:111` rely solely on parent IDs without adding explicit `owner_id == owner_id` predicates.
- **Unbounded Ignored `EventIn.metadata` & WebSocket Connection Cap:** `backend/app/schemas/ledger.py:152` accepts an arbitrary-size `metadata: dict` that `intake.py` never uses; `backend/app/core/realtime.py:82-120` has no per-owner/global WebSocket connection limit or `Origin` check before `ws.accept()`.
- **Tracked `.local.` Config File, Android WorkManager Policy & Frontend File Size:** `backend/parser-rules.local.json` is tracked in Git despite its `.local.` name; `android/app/src/main/java/id/samsaku/capture/SendWorker.kt:55` uses `ExistingWorkPolicy.APPEND_OR_REPLACE` (chaining redundant jobs under notification bursts instead of `KEEP`); and `web/features/transactions/EntryForm.tsx:1-945` (945 lines) / `web/app/page.tsx:1-620` (620 lines) are candidates for splitting into smaller focused modules per `AGENTS.md` §2.
