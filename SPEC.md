# Spesifikasi Produk SamSaku (Living Spec)

> **Status Dokumen:** Sumber kebenaran tunggal (*Single Source of Truth*) untuk aturan bisnis dan kapabilitas aplikasi SamSaku. Dokumen ini dijaga tetap sinkron dengan kode sesuai aturan di [AGENTS.md](AGENTS.md).

SamSaku adalah aplikasi pencatatan keuangan pribadi satu pemilik (*single-owner*) dalam mata uang Rupiah (IDR). Pemilik mengakses PWA yang sama di HP, tablet, dan desktop, sementara konektor Gmail, Telegram, dan APK Android meneruskan bukti transaksi ke API yang sama.

---

## 1. Aturan Pembukuan (Core Ledger)

- **Rupiah bulat eksak:** Semua nominal disimpan sebagai integer (`BigInteger`) dalam Rupiah bulat tanpa floating-point rounding.
- **Zona waktu laporan:** Seluruh perhitungan batas hari, siklus bulanan, dan tampilan tanggal menggunakan `Asia/Jakarta` (WIB).
- **Double-entry saldo & alokasi kategori terpisah:**
  - Setiap transaksi membuat satu atau lebih baris perubahan saldo (`account_entries`) dan rincian pelaporan (`transaction_allocations` / `splits`).
  - Transaksi `income` dan `expense` mendukung satu kategori atau *split* beberapa kategori (jumlah rincian wajib sama dengan nominal transaksi).
  - **Transfer:** Transfer `Rp100.000` dengan biaya admin `Rp1.000` menghasilkan mutasi asal `-Rp101.000` dan tujuan `+Rp100.000`; pengeluaran laporan hanya mencatat biaya admin `Rp1.000`.
  - **Refund:** Harus merujuk transaksi pengeluaran asal pada/sebelum tanggal refund, tidak boleh melebihi sisa pengeluaran kategori asal, dan menurunkan pengeluaran pada periode tanggal refund.
- **Saldo pembuka (*opening balance anchor*):**
  - Berlaku mulai awal `opening_date` per dompet.
  - Transaksi sebelum `opening_date` tetap tercatat di riwayat & laporan historis (ditandai `partial_history: true`), tetapi saldo berjalan dompet hanya menjumlahkan mutasi pada dan setelah `opening_date`.
- **Hapus dompet & kategori secara aman:**
  - Menghapus dompet yang masih memiliki transaksi mewajibkan pilihan: pindahkan seluruh transaksi ke dompet lain (`transfer_to`) atau hapus berantai (`cascade=true`).
  - Menghapus kategori mendukung pengalihan transaksi/subkategori ke kategori pengganti (`transfer_to`) atau menjadi *Belum dikategorikan*.

---

## 2. Siklus Waktu, Anggaran & Pengaturan

- **Siklus bulanan fleksibel (`monthly_start_day` 1–31):**
  - Default tanggal 1 (kalender normal).
  - Mendukung siklus gajian (misalnya tanggal 25/26). Jika `monthly_start_day >= 15`, nama bulan siklus mengikuti bulan berakhirnya periode (contoh: `26 Sep – 25 Okt 2026` dilabeli Oktober 2026).
- **Awal pekan (`weekly_start_day` 0–6):** Mengatur hari pertama pada tampilan kalender transaksi, rekap mingguan, dan grafik pola harian.
- **Dompet utama (`default_account_id`):** Dipilih otomatis saat mencatat transaksi baru maupun memproses foto struk dari Telegram.
- **Anggaran bulanan per kategori (`budgets`) & Cycle Pacing:**
  - Ditetapkan pada kategori pengeluaran. Jika anggaran dipasang pada kategori induk, realisasi otomatis menjumlahkan pengeluaran kategori induk beserta seluruh subkategorinya.
  - Status otomatis menggunakan aritmetika integer eksak: `safe` (`spent * 5 < amount * 4`), `warning` (`80%–100%`), `over` (`>100%`), lengkap dengan perhitungan *cycle pacing* (`% anggaran terpakai` vs `% waktu siklus berjalan`), *safe daily allowance* (mengacu sisa anggaran, atau cadangan arus kas bersih bila anggaran belum dibuat), dan peringatan proaktif (`budget_alerts`) di Dashboard, Anggaran, dan balasan Telegram.
- **Perbandingan kategori lintas siklus (`category_deltas`):**
  - Menghitung perubahan pengeluaran bersih per kategori antara siklus aktif dan siklus sebelumnya dalam batch query yang sama tanpa query N+1.
- **Idempotensi & konsistensi replay:**
  - `POST /v1/transactions` mendukung header `Idempotency-Key` (sebagai cadangan `source_ref`) dan menekan siaran WebSocket ganda pada retry identik.
  - Replay dengan payload berbeda pada `/v1/transactions`, `/v1/reviews/{key}/resolve`, `/v1/imports/{job_id}/commit`, dan `/v1/receipts/{job_id}/confirm` ditolak dengan `409 Conflict`.

---

## 3. Bukti Otomatis, Scan Struk AI, Impor Excel & Alokasi Pos

- **Konektor bukti (`bca`, `gopay`, `telegram`):**
  - Gmail Apps Script (`connectors/gmail/`) meneruskan bukti email BCA ke `POST /v1/events/bca`.
  - APK Android (`android/`) meneruskan notifikasi GoPay/Gojek ke `POST /v1/events/gopay`.
  - Bot Telegram (`POST /v1/webhooks/telegram` atau long-polling jika `SAMSAKU_TELEGRAM_POLL=1` tanpa webhook HTTPS) langsung menyimpan otomatis (*instant auto-save*) catatan teks (`kopi 35k`, `gaji 8jt bca`) maupun foto struk/bukti transfer ketika nominal dan dompet jelas (fallback ke `default_account_id` untuk non-transfer) serta bebas kandidat duplikat.
  - Balasan Telegram langsung menampilkan ringkasan transaksi, **sisa anggaran kategori** (bila beranggaran), dan **saldo dompet terbaru**, disertai tombol inline 1-klik (`Ganti Kategori`, `Ganti Dompet`, `Hapus`). Bukti ambigu, dompet belum jelas, atau kandidat duplikat masuk ke antrean **Perlu ditinjau** (`/v1/reviews`) dengan alasan eksplisit.
  - Mendukung rekap harian opsional pukul **21:00 WIB (`Asia/Jakarta`)** yang idempoten (maksimal 1x/hari) saat `SAMSAKU_TELEGRAM_DAILY_RECAP=1`.
  - Deteksi duplikat ketat lintas kanal menolak pengulangan `update_id` Telegram, pengulangan `digest` SHA-256 foto struk, `source_ref` penyedia yang sama, serta kandidat transaksi sama-hari/nominal/dompet.
  - Data sensitif (nomor rekening/kartu, OTP, PIN, password) disamarkan otomatis sebelum disimpan (`redact`).
  - Pencatatan otomatis memerlukan template parser terverifikasi (`verified: true`), referensi penyedia, dan tanggal valid; bukti ambigu masuk antrean **Perlu ditinjau** (`/v1/reviews`).
- **Scan struk & bukti transfer berbasis Gemini Vision AI:**
  - Endpoint `POST /v1/receipts/scan` (auto-fill form lintas tab) dan `POST /v1/receipts/{job_id}/process` (termasuk bot Telegram) menggunakan **Gemini Vision API** (default model `gemini-3.5-flash-lite`, dapat diatur via `GEMINI_MODEL`).
  - Mengekstrak **jenis transaksi** (QRIS, Transfer ke BCA, BI-FAST, BCA Virtual Account, dll.), **berita/catatan**, nominal pokok, biaya admin, total bayar, serta nomor rekening asal & tujuan. Klasifikasi kategori memprioritaskan **Berita → Penerima/Merchant → Jenis Transaksi → histori transaksi** (mendukung kategori pengeluaran maupun pemasukan).
  - Setiap dompet dapat menyimpan `account_number` opsional (disarankan nomor rekening penuh 10 digit untuk BCA agar cocok dengan format tersamarkan di tengah myBCA seperti `883 - 2** - **41`, atau nomor HP untuk e-wallet; tidak unik agar 1 nomor HP bisa dipakai bersama oleh beberapa e-wallet). Pencocokan nomor rekening dilakukan murni di backend (*exact*, *wildcard pattern match* untuk nomor tersamarkan tengah/depan, *suffix match*, serta penyedia/prefix BCA VA seperti `70001` GoPay, `39358` OVO, `3901` DANA, `122` ShopeePay) tanpa mengirim nomor rekening pemilik ke API AI, serta mengabaikan `Merchant PAN`, `Customer PAN`, dan `Pengakuisisi` pada bukti QRIS:
    - Sumber = dompet sendiri & Tujuan = dompet sendiri → otomatis `transfer` (memisahkan `amount` & `fee` biaya admin).
    - Sumber = rekening orang lain & Tujuan = dompet sendiri → otomatis `income`.
    - Sumber = dompet sendiri & Tujuan = rekening/merchant lain → `expense` dengan total bayar (`nominal + biaya admin`).
    - Nomor rekening mentah disamarkan (`****7890`) di `source_events` dan tampil tersamarkan (`•••• 7890`) di kartu dompet PWA.
  - OCR lokal Tesseract **sengaja tidak dipasang** agar ukuran Docker image kecil dan VPS murah aman dari lonjakan RAM.
- **Impor Excel (`.xlsx`):**
  - Menyediakan template unduhan untuk `masters` dan `transactions`, pemetaan kolom fleksibel (dapat disimpan ulang), pratinjau tanpa mengubah buku kas (savepoint rollback), deteksi duplikat & transaksi mirip (termasuk *fingerprint* isi baris untuk baris tanpa referensi agar edit 1 sel tetap menjaga deduplikasi baris lain, serta pencocokan refund lintas dompet via `original_ref`), pembatasan dekompresi stream ZIP anti *zip-bomb*, publikasi atomik dalam satu transaksi database, dan pembersihan objek `FILE_STORAGE_BUCKET` saat `reset_owner_data`.
- **Alokasi pos & target (`schemes`, `goals`, `reserves`):**
  - Tersedia di API `/v1/schemes` & `/v1/goals` (serta `DELETE /v1/goals/{key}` yang melepas `Reserve.goal_id = NULL` secara aman) dan panel UI **Target & Amplop Tabungan** (`GoalsPanel`) di halaman **Anggaran** untuk mencadangkan pemasukan bebas ke pos tetap (`fixed`), persentase (`percent`), atau sisa (`remainder`) tanpa membuat mutasi saldo bank.

---

## 4. Antarmuka Pengguna (PWA) & Sinkronisasi Realtime

- **Halaman utama PWA:**
  1. **Ringkasan (`home`):** Hierarki 3-zona bersih: (1) banner draf tinjauan aktif (dengan **Simpan 1-Klik**) + banner peringatan anggaran proaktif 80%/100% + kartu ringkasan total saldo seluruh dompet, *safe daily allowance* beserta *pacing* siklus, dan 3 KPI arus kas siklus aktif, (2) deretan kartu dompet visual sejajar, serta (3) dua kolom seimbang berisi Transaksi Terakhir dan Pantauan Anggaran / Pos Pengeluaran Terbesar.
  2. **Input Cepat (`EntryForm` & submodul terfokus):** Dimodularisasi (`EntryHeaderControls`, `EntryAmountBox`, `EntryStandardFields`, `EntryTransferFields`, `EntryAdvancedSection`, `EntryFormFooter`, `entryPayload`, `useReceiptAutoFill`, masing-masing `< 400` baris); mode cepat 1-layar dengan nominal besar auto-fokus (preset & pengali `.000`), tanggal cepat (`Hari ini` / `Kemarin` / pilih tanggal) + tombol ringkas Scan Struk AI, `CategoryPicker` pintar, dompet utama terpilih otomatis dengan estimasi sisa saldo, catatan singkat dengan saran kategori non-intrusif, opsi lanjutan terlipat (Split kategori & Refund), serta footer *sticky* dengan tombol **Simpan & Lagi** untuk input beruntun. Di layar mobile, tombol utama `+ Catat` berada tepat di tengah navigasi bawah.
  3. **Transaksi (`transactions`):** 3 mode tampilan (**Harian**, **Kalender**, **Mingguan**) yang menyatu dengan pemilih siklus (`< Bulan >` + `Hari Ini`) tanpa mereset mode tampilan saat berpindah bulan maupun saat terjadi *silent refresh*, dilengkapi pencarian cepat, laci filter terlipat (Dompet, Jenis termasuk Refund, Kategori) dengan chip indikator aktif, serta rekap 1 baris. Total pengeluaran di Kalender dan Grafik Statistik menghitung nilai bersih termasuk refund dan biaya admin transfer agar konsisten dengan `summary.expense`.
  4. **Anggaran (`budgets`):** Total anggaran vs terpakai, bilah perbandingan *pacing* siklus (`% terpakai` vs `% waktu siklus`), banner peringatan proaktif 80%/100%, *safe daily allowance*, daftar progres per kategori, panel **Target & Amplop Tabungan** (`GoalsPanel`), dan daftar kategori belum beranggaran.
  5. **Statistik (`stats`):** Grafik donat interaktif (pengeluaran & pemasukan), perbandingan siklus lalu beserta perubahan kategori terbesar (`category_deltas`), pola pengeluaran per hari dalam sepekan, grafik arus kas harian/mingguan, anggaran vs realisasi, dan distribusi saldo dompet.
  6. **Tinjauan (`reviews`):** Dapat diakses langsung dari Sidebar & Topbar dengan badge jumlah antrean *live*; mendukung **Simpan 1-Klik**, ubah/tautkan ke transaksi yang ada, atau abaikan bukti.
  7. **Laporan (`reports`):** Pratinjau laporan periode siklus atau rentang tanggal khusus, unduh **CSV** (baik server maupun ekspor klien pada mode Sandbox menetralisir payload *formula injection* `=`, `+`, `-`, `@`, `\t`, `\r` lewat `web/lib/csv.ts`) dan **PDF** (dirender di server lewat subprocess WeasyPrint terisolasi dengan batas konkurensi & rentang/baris).
  8. **Impor Excel (`import`):** Alur unggah → pemetaan kolom → pratinjau dampak → terapkan.
  9. **Master data (`masters`):** Kelola dompet, kategori (induk/subkategori/arsip), dan status aktivitas konektor otomatis.
  10. **Pengaturan (`settings`):** Tema Terang/Gelap (*Light/Dark Mode*), siklus bulanan, awal pekan, dompet utama, reset data Sandbox, serta **Zona Bahaya** untuk **Reset Data fleksibel** maupun **Wipe Semua Data** via `POST /v1/data/reset`.
- **Mode Sandbox Interaktif:** Saat belum login ke server, pengguna dapat menjelajahi seluruh fitur (termasuk Target Tabungan & *pacing*) dengan data contoh di `localStorage` (kode `demo.ts` di-load dinamis hanya saat belum login).
- **Sinkronisasi Realtime (`WS /v1/ws`) & Cache Service Worker (`sw.js`):**
  - Mutasi dari perangkat lain, Telegram, Gmail, atau Android langsung mengirim event `sync` ke browser aktif untuk melakukan *silent refresh* *in-place* tanpa mereset tampilan Kalender atau filter aktif.
  - Koneksi WebSocket membatasi maksimum koneksi per pemilik & global serta memvalidasi `Origin` saat `CORS_ORIGINS` eksplisit, memakai *jittered exponential backoff* di klien, dan otomatis menjalankan rekonsiliasi `/v1/bootstrap` saat tersambung ulang maupun saat peramban kembali `online`.
  - Service Worker (`samsaku-public-v2`) langsung mengambil alih kontrol klien (`skipWaiting` / `clients.claim`), menghapus cache lama, dan memakai strategi *network-first* untuk navigasi HTML agar bundle statis terbaru selalu tersaji pasca deploy VPS.

---

## 5. Keamanan & Arsitektur VPS Murah

- **Autentikasi & CORS:** Mendukung Supabase JWT (`ES256`/`RS256` dikunci ke `OWNER_ID`) maupun token self-hosted (`SAMSAKU_DEV_TOKEN`). Di `SAMSAKU_ENV=production`, `CORS_ORIGINS` wajib diisi secara eksplisit tanpa wildcard `*`.
- **Pertahanan Edge (`ops/Caddyfile` & `rate_limit.py`):**
  - Caddy menambahkan security headers (`Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`) serta batas ukuran body (`1MB` untuk webhook, `8MB` untuk endpoint `/v1/*`).
  - FastAPI menegakkan rate limit in-memory berbatas memori per IP (`429` + `Retry-After`) pada webhook/intake (`SAMSAKU_RATE_LIMIT_WEBHOOK_PER_MIN`) dan lonjakan kegagalan autentikasi (`SAMSAKU_RATE_LIMIT_AUTH_FAIL_PER_MIN`).
- **Isolasi Data & Pemulihan Cadangan:** Seluruh tabel PostgreSQL mengaktifkan RLS dan mencabut akses `PUBLIC`, `anon`, serta `authenticated`; `ops/backup.py restore` otomatis menjalankan ulang `REVOKE_PRIVILEGES_SQL` pasca `pg_restore --no-privileges`.
- **Target Efisiensi VPS (512 MB – 2 GB RAM):**
  - 3 container produksi (`db`, `api`, `caddy`) tanpa container Nginx terpisah.
  - 1 request `GET /v1/bootstrap` saat membuka/refresh aplikasi, query batch O(1), composite database indexes, serta PDF WeasyPrint di subprocess `spawn` terisolasi yang dijaga semaphore tunggal (`_PDF_SEMAPHORE`), batas rentang 367 hari, dan batas 500 baris rincian.

---

## 6. Rencana Pengembangan Berikutnya (Roadmap)

Pengembangan lanjutan yang belum diimplementasikan (harus tetap memakai buku kas & kepemilikan data yang ada):
- Tagihan berulang (*recurring bills*), cicilan, dan paylater (pisahkan peristiwa terjadwal dari transaksi terkonfirmasi).
- Proyeksi arus kas jangka panjang.
- Pencatatan aset, investasi, dan kekayaan bersih (*net worth*) dengan memisahkan perubahan nilai aset dari belanja bulanan.
