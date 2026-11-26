# Changelog SamSaku

Seluruh perubahan penting pada arsitektur, fitur, skema database, dan performa dicatat di sini.

---

## [2.1.0] — 2026-11-27 — Enhanced Scan Bukti BCA, Deteksi Sumber Dana & Transfer Antar Dompet Otomatis

### Fitur & Kecerdasan Bukti Transaksi
- **Identitas Dompet Opsional (`account_number`):** Menambahkan kolom opsional `account_number` (migrasi Alembic `0005_account_number.py`, non-unik agar 1 nomor HP bisa dipakai bersama di GoPay, OVO, DANA, ShopeePay) dengan tampilan tersamarkan (`•••• 7890`) di kartu dompet PWA dan input di Master Data.
- **Ekstraksi Gemini Vision Terstruktur (`ocr.py` & `receipt_matching.py`):** Membaca **jenis transaksi** (QRIS, Transfer ke BCA, BI-FAST, BCA Virtual Account, dll.), **berita transfer**, nominal pokok, biaya admin, total bayar, serta bank & nomor rekening asal/tujuan. Klasifikasi kategori memprioritaskan **Berita → Penerima/Merchant → Jenis Transaksi → histori** untuk pengeluaran maupun pemasukan.
- **Deteksi Otomatis Transfer Antar Dompet, Pemasukan & Sumber Dana:** Pencocokan nomor rekening dilakukan murni di backend (*suffix match* + peta prefix BCA VA `70001`/`39358`/`3901`/`122`/`09110`, mendukung nomor tersamarkan m-BCA `***7890` tanpa mengirim nomor rekening pemilik ke API AI). Transfer antar dompet otomatis memisahkan `amount` dan `fee`; pengeluaran ke pihak luar memakai total bayar; nomor rekening mentah disamarkan (`****7890`) sebelum disimpan ke `source_events`.
- **Telegram & PWA Terpadu:** Bot Telegram kini mendukung simpan 1-klik untuk `transfer` (`Dari → Ke` + admin), `income`, dan `expense` serta memanfaatkan caption foto sebagai petunjuk dompet/berita. Form transaksi Web App (`EntryForm`) membuka auto-fill foto struk di semua tab dan otomatis berpindah tab sesuai hasil deteksi.

---

## [2.0.0] — 2026-11-26 — Refactor Arsitektur, Optimasi VPS Murah & Living Spec

### Arsitektur & Maintainability
- **Backend berlapis (`backend/app/`):** Memecah file datar/monolitik (`main.py`, `ledger.py`, `jobs.py`, `tools_api.py`) ke struktur `core/`, `models/`, `schemas/`, `services/`, dan `routers/` dengan seluruh model ORM diseragamkan ke SQLAlchemy 2.0 `Mapped` style.
- **Frontend modular (`web/`):** Memecah `page.tsx` (1.306 baris), `Entries.tsx` (1.081 baris), `Importer.tsx`, dan `globals.css` (2.680 baris) ke `hooks/`, `components/ui/`, `components/layout/`, `features/*`, `lib/format.ts`, dan `styles/{tokens,base,components,pages}.css`.
- **Pembersihan kode mati & dependency:** Menghapus Tailwind CSS v4 (tidak dipakai), `@fontsource/instrument-serif` (tidak dipakai), `postcss.config.mjs`, dan wrapper kosong `Receipt.tsx`.

### Performa & Efisiensi VPS Murah (512 MB – 2 GB RAM)
- **Single-request Bootstrap (`GET /v1/bootstrap`):** Memangkas pemuatan/refresh dashboard dari 7 HTTP request paralel/waterfall menjadi 1 HTTP request tunggal.
- **Eliminasi N+1 Query:** Batch query untuk `/v1/accounts` (3 query total), `/v1/transactions` (O(1) query), `/v1/summary`, `/v1/budgets`, dan `/v1/schemes`; menghapus `lock_owner` pada endpoint baca (`summary`); menambah SQL `SUM/GROUP BY` untuk agregasi; menambah shared `httpx.Client` dan cache `parser-rules.json`.
- **Migrasi Index Performa (`0004_performance_indexes.py`):** Menambahkan 7 index/composite index pada `transactions`, `account_entries`, `source_events`, dan `reserves`.
- **Hemat RAM OCR & PDF:** Menghapus `tesseract-ocr` & `pytesseract` (scan struk memakai Gemini Vision API saja) dan menjalankan WeasyPrint PDF dalam subprocess `spawn` terisolasi agar memori Pango/Cairo langsung dikembalikan ke OS.
- **Bundle & Sinkronisasi Frontend:** Menambahkan lazy-loading `next/dynamic` untuk seluruh halaman & modal sekunder, dynamic `import("./demo")` agar mode sandbox tidak ikut terunduh saat login, serta cooldown 30 detik pada `visibilitychange` saat WebSocket berstatus `live`.
- **Infrastruktur 3 Container (`compose.prod.yaml`):** Menggabungkan static build web langsung ke container `caddy` (menghapus container Nginx terpisah), menambahkan kompresi `zstd`/`gzip`, header cache `immutable` untuk `/_next/static/*`, tuning RAM PostgreSQL, dan batas memori per container.

### Dokumentasi Living Spec & Penjagaan 3 Lapis
- Menambahkan [AGENTS.md](../AGENTS.md), memperbarui [SPEC.md](../SPEC.md) & [README.md](../README.md), serta menyusun `docs/ARCHITECTURE.md`, `docs/DATABASE.md`, `docs/API.md`, `docs/VPS_DEPLOYMENT.md`, `docs/CHANGELOG.md`, dan `docs/openapi.json`.
- Menambahkan `ops/export_openapi.py` dan `backend/tests/test_docs_sync.py` + `test_performance.py`.
- Mengaktifkan GitHub Actions CI ([.github/workflows/verify.yml](../.github/workflows/verify.yml)) otomatis pada setiap `push` dan `pull_request` ke `main`.
