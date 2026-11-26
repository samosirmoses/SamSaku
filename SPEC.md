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
- **Anggaran bulanan per kategori (`budgets`):**
  - Ditetapkan pada kategori pengeluaran. Jika anggaran dipasang pada kategori induk, realisasi otomatis menjumlahkan pengeluaran kategori induk beserta seluruh subkategorinya.
  - Status otomatis: `safe` (<80%), `warning` (80%–100%), `over` (>100%), lengkap dengan perhitungan batas belanja aman per hari (*safe daily allowance*).

---

## 3. Bukti Otomatis, Scan Struk AI, Impor Excel & Alokasi Pos

- **Konektor bukti (`bca`, `gopay`, `telegram`):**
  - Gmail Apps Script (`connectors/gmail/`) meneruskan bukti email BCA ke `POST /v1/events/bca`.
  - APK Android (`android/`) meneruskan notifikasi GoPay/Gojek ke `POST /v1/events/gopay`.
  - Bot Telegram (`POST /v1/webhooks/telegram` atau long-polling) menerima catatan teks singkat (`kopi 35k tunai`) dan foto struk dengan tombol konfirmasi inline (`Simpan` / `Batalkan`).
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
  - Menyediakan template unduhan untuk `masters` dan `transactions`, pemetaan kolom fleksibel (dapat disimpan ulang), pratinjau tanpa mengubah buku kas (savepoint rollback), deteksi duplikat & transaksi mirip, serta publikasi atomik setelah persetujuan pemilik.
- **Alokasi pos & target (`schemes`, `goals`, `reserves`):**
  - Tersedia di API `/v1/schemes` & `/v1/goals` untuk mencadangkan pemasukan bebas ke pos tetap (`fixed`), persentase (`percent`), atau sisa (`remainder`) tanpa membuat mutasi saldo bank.

---

## 4. Antarmuka Pengguna (PWA) & Sinkronisasi Realtime

- **Halaman utama PWA:**
  1. **Ringkasan (`home`):** Total kekayaan likuid, kurva pengeluaran kumulatif, 4 kartu *Smart Financial Insights* (burn rate harian + proyeksi, perbandingan siklus lalu, kesehatan anggaran, pos terbesar), rincian kategori, progres anggaran, kartu dompet visual, notifikasi tinjauan, dan 5 transaksi terakhir.
  2. **Transaksi (`transactions`):** 3 mode tampilan (**Harian**, **Kalender heatmap**, **Mingguan & Bulanan**), pencarian, filter cepat kategori/dompet/jenis, dan input langsung pada tanggal terpilih.
  3. **Anggaran (`budgets`):** Total anggaran vs terpakai, *safe daily allowance*, daftar progres per kategori, dan daftar kategori belum beranggaran.
  4. **Statistik (`stats`):** Grafik donat interaktif (pengeluaran & pemasukan), perbandingan siklus lalu, pola pengeluaran per hari dalam sepekan, grafik arus kas harian/mingguan, anggaran vs realisasi, dan distribusi saldo dompet.
  5. **Laporan (`reports`):** Pratinjau laporan periode siklus atau rentang tanggal khusus, unduh **CSV** dan **PDF** (dirender di server lewat subprocess WeasyPrint terisolasi).
  6. **Impor Excel (`import`):** Alur unggah → pemetaan kolom → pratinjau dampak → terapkan.
  7. **Master data (`masters`):** Kelola dompet, kategori (induk/subkategori/arsip), dan status aktivitas konektor otomatis.
  8. **Pengaturan (`settings`):** Tema Terang/Gelap (*Light/Dark Mode*), siklus bulanan, awal pekan, dompet utama, serta reset data Sandbox.
  9. **Perlu ditinjau (`reviews`):** Tautkan ke transaksi yang ada, catat sebagai transaksi baru, atau abaikan bukti.
- **Mode Sandbox Interaktif:** Saat belum login ke server, pengguna dapat menjelajahi seluruh fitur dengan data contoh di `localStorage` (kode `demo.ts` di-load dinamis hanya saat belum login).
- **Sinkronisasi Realtime (`WS /v1/ws`):** Mutasi dari perangkat lain, Telegram, Gmail, atau Android langsung mengirim event `sync` ke browser aktif untuk melakukan *silent refresh* tanpa reload halaman.

---

## 5. Keamanan & Arsitektur VPS Murah

- **Autentikasi:** Mendukung Supabase JWT (verifikasi JWKS asimetris `ES256`/`RS256` dikunci ke `OWNER_ID`) maupun token self-hosted (`SAMSAKU_DEV_TOKEN`) saat dijalankan mandiri di VPS tanpa Supabase.
- **Isolasi Data:** Seluruh tabel PostgreSQL mengaktifkan Row Level Security (RLS) dan mencabut akses role publik (`PUBLIC`, `anon`, `authenticated`).
- **Target Efisiensi VPS (512 MB – 2 GB RAM):**
  - 3 container produksi (`db`, `api`, `caddy`) tanpa container Nginx terpisah.
  - 1 request `GET /v1/bootstrap` saat membuka/refresh aplikasi (menggantikan 7 request sebelumnya).
  - Query batch O(1) tanpa N+1, composite database indexes, dan subprocess terisolasi untuk render PDF WeasyPrint.

---

## 6. Rencana Pengembangan Berikutnya (Roadmap)

Pengembangan lanjutan yang belum diimplementasikan (harus tetap memakai buku kas & kepemilikan data yang ada):
- Tagihan berulang (*recurring bills*), cicilan, dan paylater (pisahkan peristiwa terjadwal dari transaksi terkonfirmasi).
- Proyeksi arus kas jangka panjang.
- Pencatatan aset, investasi, dan kekayaan bersih (*net worth*) dengan memisahkan perubahan nilai aset dari belanja bulanan.
