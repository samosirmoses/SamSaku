# Arsitektur SamSaku

Dokumen ini menjelaskan struktur kode, alur data utama, dan strategi efisiensi memori/CPU agar SamSaku berjalan cepat dan stabil pada VPS murah (512 MB – 2 GB RAM).

---

## 1. Gambaran Sistem Produksi (3 Container)

```mermaid
flowchart LR
    User["Browser / PWA (HP & Desktop)"]
    Ext["Konektor (Gmail / Android / Telegram)"]

    subgraph VPS["VPS Murah (Docker Compose: compose.prod.yaml)"]
        Caddy["caddy (128 MB)\nStatic /srv/web + HTTPS + zstd/gzip"]
        API["api / FastAPI (384 MB)\nUvicorn + SQLAlchemy 2.0"]
        PDF["Subprocess WeasyPrint\n(spawn on-demand, RAM langsung bebas)"]
        DB["db / PostgreSQL 16 (256 MB)\nTuned low-RAM + RLS + Indexes"]
    end

    Gemini["Gemini Vision API\n(Scan struk)"]

    User -->|"HTTPS + WS /v1/ws"| Caddy
    Ext -->|"HTTPS /v1/events/* & webhook"| Caddy
    Caddy -->|"Static PWA (immutable cache)"| User
    Caddy -->|"/v1/* & /health"| API
    API -->|"Pool 4+2 koneksi"| DB
    API -->|"Subprocess spawn"| PDF
    API -->|"Shared httpx.Client"| Gemini
```

### Mengapa 3 Container?
Sebelumnya `compose.prod.yaml` menjalankan 4 container (`db`, `api`, `web` Nginx, `caddy`). Sekarang `web/Dockerfile` memakai multi-stage build (target `caddy`) sehingga hasil static export Next.js (`/web/out`) langsung disajikan oleh `caddy` dari `/srv/web` — menghilangkan overhead container Nginx sepenuhnya.

---

## 2. Struktur Backend (`backend/app/`)

Backend menerapkan arsitektur berlapis (*layered architecture*) agar setiap file pendek, fokus, dan mudah dipelihara:

```text
backend/app/
├── main.py                  # Bootstrap FastAPI, lifespan, GZip, CORS, registrasi router
├── core/
│   ├── config.py            # Konstanta timezone Asia/Jakarta & pembacaan env
│   ├── db.py                # Engine SQLAlchemy (pool 4+2), SessionLocal, lock_owner
│   ├── auth.py              # Verifikasi Supabase JWKS JWT & SAMSAKU_DEV_TOKEN
│   ├── http_client.py       # Shared pooled httpx.Client untuk integrasi eksternal
│   └── realtime.py          # WebSocket hub (/v1/ws) untuk push event sync
├── models/
│   ├── ledger.py            # 14 model buku kas (SQLAlchemy 2.0 Mapped style)
│   └── jobs.py              # FileJob & ImportEntry (SQLAlchemy 2.0 Mapped style)
├── schemas/
│   ├── ledger.py            # Validasi Pydantic untuk dompet, kategori, transaksi, dll.
│   └── tools.py             # Validasi Pydantic untuk impor Excel & konfirmasi struk
├── services/
│   ├── common.py            # Helper fail(), owned(), rows(), columns()
│   ├── calculations.py      # Aturan rupiah(), cycle(), divide()
│   ├── settings.py          # Pengaturan siklus & helper tanggal periode
│   ├── accounts.py          # Batch balance/reserves/tx_count (3 query total, anti N+1) & CRUD
│   ├── categories.py        # CRUD kategori & validasi hirarki 2 tingkat
│   ├── transactions.py      # Posting double-entry, refund, batch serialize_transactions
│   ├── summary.py           # Summary & budgets dengan SQL SUM/GROUP BY (tanpa lock_owner)
│   ├── planning.py          # Skema alokasi pos & target tabungan (batch query)
│   ├── intake.py            # Redaksi PII, cache parser-rules JSON, ingest bukti
│   ├── imports.py           # Evaluasi savepoint & publikasi atomik workbook Excel
│   ├── jobs.py              # Penyimpanan file sementara (DB lokal / Supabase Storage)
│   ├── ocr.py               # Scan struk Gemini Vision only (tanpa Tesseract lokal)
│   ├── receipt_text.py      # Ekstraksi tanggal & inferensi kategori berbasis aturan/riwayat
│   ├── reports.py           # CSV & render PDF WeasyPrint di subprocess spawn terisolasi
│   └── xlsx.py              # Parser/generator workbook openpyxl yang aman
└── routers/
    ├── bootstrap.py         # GET /v1/bootstrap (1 request untuk seluruh dashboard)
    ├── accounts.py          # /v1/accounts
    ├── categories.py        # /v1/categories
    ├── transactions.py      # /v1/transactions
    ├── budgets.py           # /v1/budgets & /v1/settings
    ├── summary.py           # /v1/summary
    ├── reviews.py           # /v1/reviews, /v1/connections, /v1/events/{source}
    ├── planning.py          # /v1/goals & /v1/schemes
    ├── tools.py             # /v1/imports/*, /v1/receipts/*, /v1/reports/*, /v1/jobs/tick
    └── telegram.py          # /v1/webhooks/telegram & long-polling bridge
```

---

## 3. Struktur Frontend (`web/`)

Frontend dipecah dari file monolitik menjadi modul per fitur, custom hooks, komponen UI bersama, dan CSS modular:

```text
web/
├── app/
│   ├── layout.tsx           # Metadata PWA & font DM Sans saja
│   ├── page.tsx             # Shell utama ringkas + dynamic import halaman/modal
│   └── globals.css          # Entry import 4 file CSS modular
├── styles/
│   ├── tokens.css           # Variabel warna tema terang/gelap & tipografi
│   ├── base.css             # Reset, layout shell, sidebar, topbar, bottom-nav
│   ├── components.css       # Card, button, modal, form, chip, tx-list
│   └── pages.css            # Dashboard, kalender, statistik, anggaran, laporan, impor, FAB, responsive
├── lib/
│   ├── api.ts               # HTTP client + lazy dynamic import ./demo hanya saat sandbox
│   ├── domain.ts            # Tipe data & logika periode/filter/inferensi kategori
│   ├── format.ts            # Formatter Rupiah & tanggal terpusat (tanpa duplikasi)
│   └── demo.ts              # Sandbox interaktif di localStorage (hanya dimuat jika belum login)
├── hooks/
│   ├── useAuth.ts           # Status login Supabase / dev token + registrasi service worker
│   ├── useTheme.ts          # Persistensi tema terang/gelap
│   ├── useLedgerData.ts     # Pemuatan 1x via GET /v1/bootstrap & silent refresh
│   └── useRealtimeSync.ts   # WebSocket reconnect/ping + cooldown visibilitychange (30 detik)
├── components/
│   ├── ui/                  # Modal, Field, ErrorNote, CatIcon, WalletIcon, TxList
│   └── layout/              # SidebarNav, Topbar, PageHeader, BottomNav, QuickFab, navigation.ts
└── features/
    ├── auth/                # LoginModal
    ├── dashboard/           # DashboardView, AccountsSection, CategoriesBreakdown, SpendingLine
    ├── transactions/        # TransactionsView, EntryForm, TransactionDetailModal
    ├── budgets/             # BudgetsView
    ├── statistics/          # StatisticsView, DonutChart
    ├── reports/             # ReportsView
    ├── importer/            # ImporterView
    ├── masters/             # MastersView, MasterForm, CategoryEdit
    ├── reviews/             # ReviewsView, ReviewModal
    └── settings/            # SettingsView
```

---

## 4. Alur Data & Strategi Performa

```mermaid
sequenceDiagram
    participant UI as PWA Browser
    participant API as FastAPI
    participant PG as PostgreSQL

    UI->>API: GET /v1/bootstrap?month=2026-11 (1 request saja)
    API->>PG: Batch query (settings, accounts+balances, categories, txs+splits, budgets, reviews, connections)
    PG-->>API: Hasil terindeks (O(1) jumlah query, tanpa advisory lock)
    API-->>UI: Payload lengkap (terkompresi gzip/zstd)
    UI->>API: WS /v1/ws (auth via first message)
    Note over UI,API: Mutasi dari Telegram/HP/tab lain -> event "sync" -> silent refresh 1 request
```

### Poin Efisiensi Utama
1. **7 HTTP request → 1 HTTP request:** `GET /v1/bootstrap` menghilangkan waterfall `/settings` → 6 request paralel dan menghilangkan duplikasi hitung `budgets` & `accounts`.
2. **Zero N+1 Query:** `GET /v1/accounts`, `GET /v1/transactions`, `GET /v1/summary`, `GET /v1/schemes`, dan `GET /v1/bootstrap` semuanya memakai agregasi SQL (`GROUP BY`) dan batch lookup (`IN (...)`) yang dibuktikan lewat `backend/tests/test_performance.py`.
3. **Read-Only Bebas Lock:** `lock_owner` hanya dipakai pada mutasi tulis sehingga permintaan baca tidak saling mengantri.
4. **RAM Terkendali:**
   - Tanpa `tesseract-ocr` (~120 MB+ lebih hemat di image Docker & tidak ada lonjakan CPU/RAM OCR lokal).
   - WeasyPrint PDF dirender di subprocess `spawn` terpisah dengan timeout 30 detik agar memori Pango/Cairo langsung kembali ke sistem operasi.
   - Frontend tidak memuat Tailwind CSS v4 maupun font Instrument Serif yang tidak dipakai, serta melakukan code-splitting (`next/dynamic`) per halaman & modal.
