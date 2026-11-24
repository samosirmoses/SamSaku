# SamSaku

Aplikasi keuangan pribadi berbahasa Indonesia untuk mencatat transaksi, meninjau bukti, mengimpor Excel, mengalokasikan pemasukan ke pos, dan menarik laporan. Dashboard PWA, API, konektor Gmail, dan aplikasi pendamping Android berada dalam satu repositori.

## Menjalankan di laptop

Pasang Docker Desktop dengan Linux containers. Dari PowerShell di folder ini, jalankan:

```powershell
.\ops\init-local.ps1
docker compose up --build
```

Buka [dashboard lokal](http://localhost:3000) dan pilih koneksi lokal. Masukkan nilai `SAMSAKU_DEV_TOKEN` dari file privat `.env`. PostgreSQL memakai volume Docker. API tersedia di [dokumentasi API lokal](http://localhost:8000/docs). Compose mengikat API dan dashboard ke loopback. Untuk Linux/macOS, salin `.env.example` menjadi `.env` dan isi kedua nilai lokal dengan string acak alfanumerik sebelum menjalankan Compose.

Untuk mencoba data sendiri, buat dompet melalui dashboard atau template master di **Impor Excel**. Isi tanggal dan saldo pembuka per dompet. Buat kategori, catat satu pembayaran, lalu periksa angka di Ringkasan dan Laporan. Pilih **Atur uang** untuk melihat pratinjau pembagian pemasukan yang benar-benar tersedia.

Template dapat diisi sebelum aplikasi dijalankan: [master dompet, kategori, merchant, dan skema](web/public/templates/master.xlsx) serta [riwayat transaksi](web/public/templates/transaksi.xlsx). Gunakan sheet Petunjuk dalam masing-masing workbook.

## Arsitektur

| Bagian | Implementasi |
| --- | --- |
| Dashboard | `web/`, Next.js static export, React, TypeScript, Tailwind, DM Sans dan Instrument Serif. Panggilan data terautentikasi menuju FastAPI. |
| Buku kas | `backend/`, FastAPI, SQLAlchemy, Alembic, PostgreSQL. Bukti, baris saldo, alokasi kategori dan pos disimpan terpisah. Semua sumber menggunakan aturan pembukuan yang sama. |
| Impor dan dokumen | openpyxl untuk workbook, Pillow dan Tesseract Indonesia/Inggris untuk foto, Jinja2 dan WeasyPrint untuk PDF. Pratinjau dan konfirmasi impor merupakan operasi terpisah. File sementara dapat disimpan di bucket Supabase privat. |
| Konektor | `connectors/gmail/` membaca bukti BCA dari kotak khusus. `android/` menangkap notifikasi GoPay/Gojek yang dipilih. Telegram mengirim update ke webhook API. |

## Koneksi ke layanan pribadi

**Google Login dan cloud.** Gunakan organisasi Supabase Free khusus, aktifkan Google OAuth dan signing key asimetris untuk verifikasi JWKS. Masuk sekali agar Supabase membuat pengguna, lalu tetapkan UUID pengguna itu sebagai `OWNER_ID`. Tambahkan URL dashboard ke daftar redirect yang diizinkan. Data finansial hanya dapat diakses lewat API dengan identitas pemilik. Simpan service-role key hanya di backend.

- **Render Free** — root layanan `backend`, runtime Docker, health path `/health`. Tetapkan `SAMSAKU_ENV=production`, `OWNER_ID`, `SUPABASE_URL`, `DATABASE_URL` (pooler PostgreSQL), `MIGRATION_DATABASE_URL` (direct atau session pooler), dan `CORS_ORIGINS` (origin dashboard). Buat bucket **privat** di Supabase Storage. Tetapkan `FILE_STORAGE_BUCKET` ke nama bucket itu dan `SUPABASE_SERVICE_ROLE_KEY` di Render. Gunakan database/project khusus untuk SamSaku. Docker menjalankan migrasi saat startup.
- **Vercel Hobby** — root `web`, perintah build `npm run build`, hasil `out`. Saat build, pasang `NEXT_PUBLIC_API_URL=https://<api>/v1`, `NEXT_PUBLIC_SUPABASE_URL` dan `NEXT_PUBLIC_SUPABASE_ANON_KEY` (kunci publik proyek). Ketiadaan data pada akun baru adalah normal. Gunakan mode contoh hanya untuk menjelajahi desain.
- **Batas biaya** — gunakan paket gratis tanpa billing berbayar. Simpan data permanen di PostgreSQL. File lokal pada kontainer Render bersifat sementara. Ketika layanan dijeda, gunakan status batch dan antrean perangkat untuk melanjutkan pekerjaan setelah layanan tersedia.

**Email BCA.** Buat filter di Gmail utama berdasarkan pengirim dan subjek bukti yang kamu verifikasi, lalu teruskan hanya bukti pembayaran ke Gmail khusus. Di kotak khusus, buat filter yang memberi label pada bukti yang sesuai. Salin `connectors/gmail/Code.gs` dan manifest ke project Apps Script milik kotak khusus. Aktifkan Advanced Gmail Service. Isi Script Properties berikut.

| Kunci | Nilai |
| --- | --- |
| `API_BASE` | Origin HTTPS API, tanpa `/v1`. |
| `BCA_TOKEN` | Token acak khusus konektor yang sama dengan environment backend. |
| `LABEL_ID` | ID label Gmail khusus (hasil `Gmail.Users.Labels.list('me')`). |
| `START_UNIX_SECONDS` | Waktu mulai membaca bukti, sebagai Unix timestamp detik. |
| `JOB_RUNNER_TOKEN` | Opsional, token khusus yang juga dipasang di backend untuk melanjutkan OCR/pembersihan per jam. |

Jalankan `installSamSaku` sekali dan berikan akses ke kotak khusus. Pemicu memeriksa bukti setiap 5 menit. Pesan yang belum memiliki template parser teruji masuk **Tinjauan**. Adaptasi [contoh aturan parser](backend/parser-rules.example.json) memakai email atau notifikasi yang sudah disamarkan. Uji contoh berhasil, gagal, dan tertunda sebelum mengaktifkan `verified`. Pasang file sebagai `SAMSAKU_PARSER_RULES` di backend. Aturan otomatis memerlukan referensi penyedia dan tanggal transaksi yang dikenali. Untuk format yang memang menggunakan tanggal notifikasi, atur `use_delivery_date` secara eksplisit.

**GoPay.** Buka `android/` dengan Android Studio, gunakan JDK 17, Android SDK 35 dan Gradle 8.9. Build dengan `gradle :app:assembleDebug` lalu pasang APK pada HP sendiri. Di backend tetapkan `GOPAY_TOKEN`. Di SamSaku Android pilih GoPay atau Gojek, isi origin HTTPS backend dan token tersebut, simpan, lalu buka pengaturan izin notifikasi. Status konektor menampilkan antrean dan keberhasilan pengiriman. Aplikasi pengirim didaftarkan secara eksplisit.

**Telegram.** Tetapkan `TELEGRAM_BOT_TOKEN`, `TELEGRAM_USER_ID` numerik pemilik, dan `TELEGRAM_WEBHOOK_SECRET` yang acak. Daftarkan `https://<api>/v1/webhooks/telegram` melalui metode resmi `setWebhook` dengan `secret_token` dan tipe update `message` serta `callback_query`. Kirim `kopi 35k tunai` atau foto dengan keterangan nama dompet. Bot memeriksa ID dan jenis chat. Draf bisa disimpan dari Telegram bila lengkap atau diselesaikan di dashboard. Pendaftaran eksternal menggunakan bot milikmu.

## Cadangan dan verifikasi

`ops/backup.py` menggunakan perintah PostgreSQL (`pg_dump`, `pg_restore`, `psql`) dan GnuPG. Atur koneksi melalui `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, dan file password libpq. Jalankan `python ops/backup.py save <arsip>.gpg`, lalu uji `python ops/backup.py restore <arsip>.gpg` ke database lain dengan skema public kosong. Simpan passphrase secara terpisah dari arsip. Cadangan mencakup skema aplikasi; akun Google/Supabase Auth, secret konektor, dan file sementara di Storage dikelola terpisah. Setelah restore ke proyek lain, pastikan UUID pemilik dan hak akses peran database sesuai.

Perintah verifikasi lokal:

```text
backend/   python -m pip install -r requirements-dev.txt
backend/   python -m pytest
web/       npm install
web/       npm run typecheck
web/       npm run build
android/   gradle :app:assembleDebug
repo/      node --test connectors/gmail/tests/sync.test.cjs
```

Workflow **Verify SamSaku** dapat dipicu manual di GitHub untuk memeriksa migrasi PostgreSQL, pengujian backend dan konektor, build PWA, serta build APK. Untuk uji penerimaan, cocokkan satu transaksi BCA dari bukti ke PDF, kirim ulang notifikasi saat HP kembali online, lalu impor workbook dua kali dan periksa saldo serta baris yang ditinjau. Uji pencocokan ini memerlukan sampel tersamarkan dari format yang benar-benar kamu gunakan.
