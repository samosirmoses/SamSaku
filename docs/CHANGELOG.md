# Changelog SamSaku

Seluruh perubahan penting pada arsitektur, fitur, skema database, dan performa dicatat di sini.

---

## [2.3.0] — 2026-11-27 — Perombakan UI/UX Input Cepat, Dashboard 3-Zona, Kalender Stabil & Realtime Instan

### Antarmuka Pengguna & Pengalaman Pemakaian (`web/`)
- **Form Input Cepat 1-Layar (`EntryForm.tsx` & `CategoryPicker.tsx`):** Menyederhanakan alur pencatatan ke 4 langkah inti (Nominal auto-fokus dengan tombol `.000` & preset → Kategori → Dompet utama terpilih dengan pratinjau sisa saldo → Catatan singkat), bar ringkas tanggal cepat (`Hari ini` / `Kemarin` / pilih tanggal) + tombol Scan Struk AI, menyembunyikan fitur lanjutan (Split kategori & Refund) ke panel lipat, serta menambahkan footer *sticky* dengan tombol **Simpan & Lagi** untuk pencatatan beruntun.
- **Pemilih Kategori Terkelompok & Anti Salah Tebak (`CategoryPicker.tsx`, `domain.ts`):** Menampilkan 6–7 kategori paling sering dipakai untuk 1-klik cepat, sub-bar otomatis untuk subkategori, serta panel pencarian yang mengelompokkan Induk → Subkategori dan pembuatan kategori baru instan. Memperbaiki `matchCategoryClient` agar tidak lagi memaksa kategori pertama saat teks catatan tidak cocok.
- **Hierarki Dashboard 3-Zona Bersih (`DashboardView.tsx`, `AccountsSection.tsx`):** Menghapus duplikasi tombol dan elemen analitik bising dari halaman utama; menyusun ulang menjadi (1) banner draf tinjauan + kartu ringkas total saldo & arus kas siklus ini, (2) grid kartu dompet sejajar yang ringkas, serta (3) dua kolom seimbang untuk Transaksi Terakhir dan Pantauan Anggaran / Pos Pengeluaran Terbesar.
- **Transaksi & Kalender Bebas Reset (`TransactionsView.tsx`, `useLedgerData.ts`):** Memperbaiki bug `setData(null)` saat ganti siklus bulan yang sebelumnya meng-unmount komponen dan mereset tampilan **Kalender** kembali ke **Harian**; kini perpindahan bulan berjalan *in-place* (mempertahankan mode Kalender/Mingguan), menyatukan pemilih `< Bulan >` + tombol `Hari Ini` di toolbar transaksi, dan melipat filter ke laci `Filter` yang rapi.
- **Sinkronisasi Realtime Instan & Persetujuan Draf 1-Klik (`useLedgerData.ts`, `useRealtimeSync.ts`, `PendingDraftsBanner.tsx`, `ReviewsView.tsx`, `AppChrome.tsx`):** Menambahkan urutan request & *cache-busting* pada *silent refresh*, efek *highlight* visual untuk transaksi/draf yang baru masuk, menu **Tinjauan** dengan badge jumlah antrean *live* di Sidebar/Topbar, tombol `+ Catat` terpusat di tengah navigasi bawah mobile, *toast* interaktif, serta tombol **Simpan 1-Klik** langsung pada draf masuk.

---

## [2.2.0] — 2026-11-27 — Fitur Reset Data Fleksibel & Wipe Semua Data

### Fitur & Keamanan Data
- **Endpoint `POST /v1/data/reset` (`routers/budgets.py`, `services/settings.py`):** Menambahkan dukungan reset data atomik dengan `lock_owner` dan validasi frasa konfirmasi di backend:
  - **Mode `partial` (konfirmasi `"RESET"`):** Opsi fleksibel untuk menghapus transaksi & mutasi saldo (termasuk cadangan), membersihkan antrean bukti/review & riwayat impor, menol-kan saldo awal dompet (`opening_balance → 0`), dan/atau menghapus anggaran bulanan.
  - **Mode `wipe` (konfirmasi `"WIPE SEMUA"`):** Menghapus seluruh data milik pemilik (dompet, kategori, transaksi, bukti, anggaran, merchant, skema, goal, pengaturan) hingga kondisi kosong total.
  - Mengirim event realtime `data:reset` via `WS /v1/ws` agar seluruh perangkat aktif langsung ter-refresh.
- **Zona Bahaya di Pengaturan (`web/features/settings/DangerZone.tsx`):** Menambahkan panel Zona Bahaya pada halaman Pengaturan (mode live) lengkap dengan checkbox pilihan fleksibel dan modal konfirmasi ketik frasa sebelum eksekusi.

---

## [2.1.0] — 2026-11-27 — Enhanced Scan Bukti BCA, Deteksi Sumber Dana & Transfer Antar Dompet Otomatis

### Fitur & Kecerdasan Bukti Transaksi
- **Identitas Dompet Opsional (`account_number`):** Menambahkan kolom opsional `account_number` (migrasi Alembic `0005_account_number.py`, non-unik agar 1 nomor HP bisa dipakai bersama di GoPay, OVO, DANA, ShopeePay) dengan tampilan tersamarkan (`•••• 7890`) di kartu dompet PWA dan input di Master Data.
- **Ekstraksi Gemini Vision Terstruktur (`ocr.py` & `receipt_matching.py`):** Membaca **jenis transaksi** (QRIS, Transfer ke BCA, BI-FAST, BCA Virtual Account, dll.), **berita transfer**, nominal pokok, biaya admin, total bayar, serta bank & nomor rekening asal/tujuan. Klasifikasi kategori memprioritaskan **Berita → Penerima/Merchant → Jenis Transaksi → histori** untuk pengeluaran maupun pemasukan.
- **Deteksi Otomatis Transfer Antar Dompet, Pemasukan & Sumber Dana:** Pencocokan nomor rekening dilakukan murni di backend (*exact*, *wildcard pattern match* untuk format tersamarkan tengah myBCA seperti `883 - 2** - **41` maupun tersamarkan depan m-BCA `***7890`, *suffix match*, dan peta prefix BCA VA `70001`/`39358`/`3901`/`122`/`09110` tanpa mengirim nomor rekening pemilik ke API AI; mengabaikan `Merchant PAN`, `Customer PAN`, dan `Pengakuisisi` pada bukti QRIS). Transfer antar dompet otomatis memisahkan `amount` dan `fee`; pengeluaran ke pihak luar memakai total bayar; nomor rekening mentah disamarkan (`****7890`) sebelum disimpan ke `source_events`.
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
