# Changelog SamSaku

Seluruh perubahan penting pada arsitektur, fitur, skema database, dan performa dicatat di sini.

---

## [2.7.0] — 2026-11-28 — Analitik Pacing & Target, Pengerasan Keamanan VPS & Modularisasi Frontend (Milestone 3)

### Analitik Pacing, Peringatan Proaktif & Target Tabungan (`summary.py`, `planning.py`, `bootstrap.py`, `BudgetsView.tsx`, `GoalsPanel.tsx`, `StatisticsView.tsx`)
- **Cycle Pacing & Batas Aman Harian:** Menambahkan `compute_cycle_pacing()` di backend dan Sandbox (`demo.ts`) untuk menghitung `% anggaran terpakai` vs `% waktu siklus berjalan`, *safe daily allowance* dengan fallback arus kas bersih saat belum beranggaran, dan penanganan siklus bulan pendek (`cycle_day=31` pada Februari) maupun kondisi nol-anggaran/nol-pemasukan.
- **Peringatan Anggaran 80%/100% & Delta Kategori:** Mengekspos `budget_alerts` dan `category_deltas` dalam batch query yang sama di `/v1/summary` dan `/v1/bootstrap`, serta menampilkannya sebagai banner proaktif di Dashboard & Anggaran dan daftar perubahan kategori lintas siklus di Statistik.
- **Target & Amplop Tabungan:** Menambahkan `DELETE /v1/goals/{key}` (aman melepas `Reserve.goal_id = NULL`), menyertakan `goals` di `/v1/bootstrap`, dan menghadirkan `GoalsPanel` pada halaman Anggaran maupun mode Sandbox.

### Pengerasan Keamanan VPS & Batas Sumber Daya (`ops/Caddyfile`, `rate_limit.py`, `config.py`, `reports.py`, `ops/backup.py`, `web/lib/csv.ts`)
- **Edge Security Headers & Body Caps:** Menambahkan header `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, dan batas `request_body` (`1MB` webhook / `8MB` API) pada `ops/Caddyfile`.
- **CORS Produksi & Rate Limit Per-IP:** Mewajibkan `CORS_ORIGINS` eksplisit (tanpa `*`) di `SAMSAKU_ENV=production` serta menambahkan `SlidingWindowLimiter` di `rate_limit.py` untuk webhook/intake dan kegagalan autentikasi (`429` + `Retry-After`).
- **Bounded PDF, Privilese Backup & CSV Client-Side:** Membatasi `report_pdf()` dengan semaphore tunggal (`429` bila sibuk), rentang maks 367 hari, dan maks 500 baris rincian; memperbarui `ops/backup.py` agar `restore` menerapkan ulang `REVOKE ALL` tabel `public`; serta menetralisir payload formula CSV (`=`, `+`, `-`, `@`, `\t`, `\r`) pada `web/lib/csv.ts` (`ReportsView.tsx`).

### Modularisasi Frontend & Reliabilitas Offline/Realtime (`EntryForm`, `page.tsx`, `realtime.py`, `useRealtimeSync.ts`, `sw.js`)
- **Modularisasi < 400 Baris:** Memecah `EntryForm.tsx` (946 → terbagi ke 9 modul `< 400` baris) dan `page.tsx` (620 → terbagi ke `PageContent.tsx`, `AppDialogs.tsx`, dan `page.tsx` `< 320` baris).
- **WebSocket & Service Worker `v2`:** Menambahkan batas koneksi per pemilik (`5`) / global (`50`) serta validasi `Origin` pada `/v1/ws`, *jittered exponential backoff* plus rekonsiliasi `/v1/bootstrap` otomatis saat tersambung ulang / kembali `online` tanpa mereset filter/Kalender, dan strategi *network-first* HTML dengan `skipWaiting()` + `clients.claim()` pada `web/public/sw.js`.

---

## [2.6.0] — 2026-11-28 — Telegram Instant Auto-Save, Rekap Harian 21:00 WIB & Pengerasan Impor Excel (Milestone 2)

### Telegram Chat-First Auto-Save & Rekap Harian (`telegram.py`, `intake.py`, `jobs.py`)
- **Simpan Otomatis Instan & Umpan Balik Kaya:** Catatan teks (`kopi 35k`, `gaji 8jt bca`) maupun foto struk/bukti transfer dengan nominal & dompet jelas (fallback `default_account_id` untuk non-transfer) langsung tersimpan otomatis, membalas dengan ringkasan transaksi, **sisa anggaran kategori** aktif, **saldo dompet terbaru**, dan tombol 1-klik `[Ganti Kategori]`, `[Ganti Dompet]`, serta `[Hapus]`.
- **Deteksi Duplikat & Antrean Tinjauan:** Bukti ambigu, dompet belum jelas, atau kandidat duplikat masuk ke `/v1/reviews` dengan alasan eksplisit; pengulangan `update_id` maupun foto ber-SHA-256 `digest` identik ditolak otomatis tanpa membuat transaksi ganda.
- **Rekap Harian 21:00 WIB & Guard `SAMSAKU_TELEGRAM_POLL`:** Menambahkan rekap harian idempoten 1x/hari dalam zona waktu `Asia/Jakarta` (`SAMSAKU_TELEGRAM_DAILY_RECAP=1`) serta menjaga mode webhook agar tidak terhapus oleh long-polling.

### Pengerasan Impor Excel & Penyimpanan Eksternal (`imports.py`, `xlsx.py`, `ocr.py`, `settings.py`)
- **Commit Atomik Tunggal & Deduplikasi Stabil:** Menggabungkan validasi persetujuan dan `evaluate(..., apply=True)` dalam satu transaksi database agar kegagalan tengah batch tidak membuat job tersangkut di status `"approved"`; menambahkan *content-hashed row fingerprints* untuk baris tanpa referensi serta pencocokan refund lintas dompet via `original_ref`.
- **Proteksi ZIP Bomb & Pembersihan Storage:** Menambahkan batas dekompresi stream aktual `32 MiB` di `xlsx.workbook()` (kebal terhadap `ZipInfo.file_size` palsu), menyelaraskan `Evidence.status` (`"posted"` vs `"linked"`), serta menghapus objek `FILE_STORAGE_BUCKET` saat `reset_owner_data` dan menahan `object_key` bila `purge_remote_file` gagal agar bisa diulang via `/v1/jobs/tick`.

---

## [2.5.0] — 2026-11-28 — Pembersihan Arsitektur Berlapis, Idempotensi Replay & Akurasi Kalender/Statistik (Milestone 1)

### Arsitektur & Idempotensi Backend (`backend/`)
- **Pemisahan Router & Service (`services/{accounts,categories,planning,reviews,bootstrap,imports,ocr,jobs,telegram}.py`):** Memindahkan seluruh query ORM, state machine, dan aturan bisnis keluar dari `backend/app/routers/` ke lapisan `services/`, memastikan `lock_owner` dipanggil sebelum query tulis dan tidak pernah dipakai pada rute `GET` maupun `POST /v1/schemes/{key}/preview`, serta menambah filter `owner_id` defense-in-depth pada tabel anak.
- **Header `Idempotency-Key` & Deteksi Konflik Replay (`transactions.py`, `reviews.py`, `imports.py`, `ocr.py`):** Menghubungkan header `Idempotency-Key` pada `POST /v1/transactions`, menekan siaran `realtime_notify` ganda pada retry idempoten, memvalidasi split pada retry `refund`, serta mengembalikan `409 Conflict` saat replay berbeda pada `/v1/transactions`, `/v1/reviews/{key}/resolve`, `/v1/imports/{job_id}/commit`, dan `/v1/receipts/{job_id}/confirm`.
- **Validasi Bootstrap & Konsistensi Anggaran (`bootstrap.py`, `settings.py`, `summary.py`):** Memvalidasi `month` (`01–12`) dengan HTTP `422`, menyamakan tanggal cutoff saldo `accounts[].balance` dan `summary.accounts[].balance` di `/v1/bootstrap`, dan mengganti ambang peringatan anggaran 80% menjadi aritmetika integer eksak (`spent * 5 >= b.amount * 4`).

### Akurasi Kalender, Statistik & UX (`web/`)
- **Kalender & Grafik Akurat Terhadap Refund (`lib/charts.ts`, `TransactionsView.tsx`, `StatisticsView.tsx`, `DonutChart.tsx`):** Menghapus clamp `Math.max(0, expense(tx))` per transaksi sehingga refund mengurangi total pengeluaran harian/kalender/mingguan agar konsisten dengan `summary.expense`, menambah filter jenis `refund` dan tombol lompat cepat `Hari ini`, serta mengamankan `DonutChart` dari nilai SVG negatif saat kategori bernilai kredit bersih lintas periode.

---

## [2.4.0] — 2026-11-28 — Stabilisasi Inti Buku Kas, Constraint DB, Keamanan & Konkurensi (Milestone 0)

### Integritas Pembukuan & Matematika Keuangan
- **Integritas Cadangan, Refund, Dompet & Kategori (`transactions.py`, `accounts.py`, `categories.py`):** Membalikkan `Reserve.remaining` sebelum menghapus `ReserveMovement` pada edit/hapus transaksi, memblokir edit/hapus pengeluaran induk yang melanggar batas refund tertaut atau pemasukan yang sudah dialokasikan ke pos cadangan, memperbaiki urutan penghapusan FK pada `delete_account(..., cascade=True)`, memblokir perubahan `Category.kind` setelah direferensikan, serta menangani `ReserveMovement` dan `category_ids` JSON saat `delete_category`.
- **Presisi Parsing & Saldo Awal (`xlsx.py`, `calculations.py`, `MasterForm.tsx`, `format.ts`):** Memperbaiki `xlsx.money()` agar pemisah ribuan koma seperti `"50,000"` tidak terbaca 1000x lebih kecil, mendukung `"IDR 50000.00"` pada `rupiah()`, serta mempertahankan saldo awal negatif (`−`) dan dompet tanpa tanggal acuan (`null`) di `MasterForm`.
- **Constraint Integritas Database (`0006_integrity_constraints.py`):** Menambahkan `CHECK` constraint pada `categories`, `transactions`, `goals`, `reserves`, dan `budgets` di PostgreSQL/SQLite.

### Keamanan, Konkurensi & Reliabilitas
- **Aturan Parser Linear-Time (`parser-rules*.json`, `intake.py`):** Mengganti pola berantai `.*?` menjadi ekstraksi field independen untuk mencegah ReDoS polinomial serta menangkap prefiks mata uang `IDR`/`Rp`.
- **Hardening Auth & Secret (`realtime.py`, `auth.py`, `db.py`, `telegram.py`, `ocr.py`):** Menghapus autentikasi token lewat query parameter WebSocket, memakai `secrets.compare_digest` untuk webhook Telegram, memakai helper `is_production()`/`app_env()`, dan mengirim `GEMINI_API_KEY` melalui header `x-goog-api-key`.
- **Dekopel Kunci DB dari HTTP Eksternal (`ocr.py`, `tools.py`, `telegram.py`, `jobs.py`):** Melepas `lock_owner()` dan transaksi database sebelum panggilan HTTP Gemini Vision / Telegram / Supabase Storage, serta memajukan `offset` long-polling Telegram hanya setelah update berhasil diproses.
- **Dukungan Non-HTTPS VPS (`EntryForm.tsx`, `format.ts`):** Menambahkan helper `generateUUID()` dengan fallback aman di luar Secure Context.

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
