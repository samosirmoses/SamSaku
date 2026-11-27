# Referensi API SamSaku

Semua endpoint aplikasi memakai awalan `/v1` (kecuali `/health`), mengembalikan `Cache-Control: private, no-store`, dan memakai kompresi `GZip` untuk respons besar.

> **Kontrak Mesin (Auto-Synced):** Snapshot OpenAPI lengkap yang diverifikasi otomatis oleh `pytest` dan CI tersedia di [docs/openapi.json](openapi.json). Jika ada perubahan endpoint atau schema, jalankan `python ops/export_openapi.py`.

---

## 1. Autentikasi

| Mode | Header / Kredensial | Dipakai Oleh |
| --- | --- | --- |
| **Pemilik (Supabase JWT)** | `Authorization: Bearer <access_token>` | PWA produksi dengan Supabase Auth (`OWNER_ID` terisi) |
| **Pemilik (Self-Hosted Token)** | `X-Dev-Token: <SAMSAKU_DEV_TOKEN>` | Lokal atau VPS mandiri tanpa `OWNER_ID` Supabase |
| **Konektor Eksternal** | `Authorization: Bearer <BCA_TOKEN \| GOPAY_TOKEN \| TELEGRAM_TOKEN>` | Gmail Apps Script & Android APK |
| **Webhook Telegram** | `X-Telegram-Bot-Api-Secret-Token: <secret>` | Server Telegram |
| **Job Runner** | `X-Job-Token: <JOB_RUNNER_TOKEN>` | Cron / pemicu berkala `POST /v1/jobs/tick` |

---

## 2. Daftar Endpoint Utama

### Kesehatan & Bootstrap
| Method | Path | Deskripsi |
| --- | --- | --- |
| `GET` | `/health` | Cek status server (`{"status": "ok"}`) |
| `GET` | `/v1/bootstrap` | **Endpoint gabungan utama PWA.** Parameter opsional `month=YYYY-MM` atau `start` & `end`. Mengembalikan `month`, `settings`, `accounts`, `categories`, `transactions`, `reviews`, `budgets`, `summary`, `connections` dalam 1 request. |
| `WS` | `/v1/ws` | WebSocket realtime (auth lewat pesan pertama `{"type":"auth", ...}` atau query param). Mendorong event `{"type":"sync","event":"..."}` saat ada mutasi. |

### Dompet, Kategori & Transaksi
| Method | Path | Deskripsi |
| --- | --- | --- |
| `GET` / `POST` | `/v1/accounts` | Daftar dompet (termasuk `account_number`, `balance`, `reserved`, `free_balance`, `tx_count` via batch query) / tambah dompet |
| `PATCH` / `DELETE` | `/v1/accounts/{key}` | Ubah dompet / hapus dompet (`?transfer_to=<id>` atau `?cascade=true`) |
| `GET` / `POST` | `/v1/categories` | Daftar kategori / tambah kategori (mendukung `parent_id`) |
| `PATCH` / `DELETE` | `/v1/categories/{key}` | Ubah kategori / hapus kategori (`?transfer_to=<id>`) |
| `GET` / `POST` | `/v1/transactions` | Daftar transaksi periode (`start`, `end`) dengan serialisasi batch / catat transaksi baru |
| `PUT` / `PATCH` / `DELETE` | `/v1/transactions/{key}` | Ubah atau hapus transaksi |

### Ringkasan, Anggaran & Pengaturan
| Method | Path | Deskripsi |
| --- | --- | --- |
| `GET` | `/v1/summary` | Ringkasan arus kas, kategori pengeluaran/pemasukan, anggaran, periode pembanding, dan saldo per dompet |
| `GET` / `POST` | `/v1/budgets` | Daftar progres anggaran periode / buat atau ubah anggaran kategori |
| `DELETE` | `/v1/budgets/{key}` | Hapus anggaran |
| `GET` / `PUT` | `/v1/settings` | Baca atau simpan `monthly_start_day`, `weekly_start_day`, `default_account_id` |
| `POST` | `/v1/data/reset` | Reset data secara fleksibel (`mode="partial"`, konfirmasi `"RESET"`) atau hapus seluruh data pemilik hingga kosong total (`mode="wipe"`, konfirmasi `"WIPE SEMUA"`) |

### Bukti Otomatis, Tinjauan & Telegram
| Method | Path | Deskripsi |
| --- | --- | --- |
| `GET` | `/v1/reviews` | Daftar bukti berstatus `review` |
| `POST` | `/v1/reviews/{key}/resolve` | Selesaikan bukti: `link`, `post`, atau `ignore` |
| `GET` | `/v1/connections` | Waktu terakhir menerima bukti dari `bca`, `gopay`, `telegram` |
| `POST` | `/v1/events/{source}` | Terima mutasi dari konektor (`bca`, `gopay`, `telegram`) |
| `POST` | `/v1/webhooks/telegram` | Terima update pesan/foto/callback tombol inline Telegram |

### Impor Excel, Scan Struk AI & Laporan
| Method | Path | Deskripsi |
| --- | --- | --- |
| `GET` | `/v1/imports/template` | Unduh template `.xlsx` (`kind=transactions\|masters`) |
| `POST` | `/v1/imports/upload` | Unggah workbook `.xlsx` (maks 6 MB) & baca daftar sheet |
| `GET` | `/v1/imports` & `/v1/imports/mappings` | Riwayat batch impor & pemetaan kolom tersimpan |
| `GET` | `/v1/imports/{job_id}` & `/v1/imports/{job_id}/errors` | Status batch & ekspor CSV baris bermasalah |
| `POST` | `/v1/imports/{job_id}/preview` | Pratinjau dampak impor (savepoint rollback, tidak mengubah buku kas) |
| `POST` | `/v1/imports/{job_id}/commit` | Publikasi atomik batch yang sudah ditinjau |
| `POST` | `/v1/receipts/scan` | Scan struk & bukti transfer via **Gemini Vision AI** untuk auto-fill form (otomatis deteksi `expense`/`income`/`transfer`, dompet asal/tujuan, biaya admin, jenis transaksi, berita & kategori) |
| `POST` | `/v1/receipts`, `/v1/receipts/{job_id}/process`, `/v1/receipts/{job_id}/confirm` | Alur unggah → proses AI → konfirmasi struk berbasis job |
| `GET` | `/v1/reports/{format}` | Unduh laporan `csv` atau `pdf` (`start`, `end`, `details=true\|false`) — PDF dirender di subprocess terisolasi |
| `POST` | `/v1/jobs/tick` | Bersihkan file sementara kedaluwarsa & lanjutkan job tertunda |

### Target & Skema Alokasi (Kompatibilitas API)
| Method | Path | Deskripsi |
| --- | --- | --- |
| `GET` / `POST` | `/v1/goals` | Daftar target tabungan & total cadangan / buat target |
| `GET` / `POST` | `/v1/schemes` | Daftar skema & pos cadangan (batch query) / buat skema |
| `PUT` | `/v1/schemes/{key}` | Perbarui aturan skema |
| `POST` | `/v1/schemes/{key}/preview` & `/apply` | Pratinjau & terapkan pembagian pemasukan ke pos cadangan |
