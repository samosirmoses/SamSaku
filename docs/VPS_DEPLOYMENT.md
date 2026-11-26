# Panduan Deploy & Operasional VPS Murah (Docker Compose)

Panduan step-by-step menjalankan SamSaku secara mandiri di VPS Linux murah (512 MB – 2 GB RAM, 1 vCPU) menggunakan [compose.prod.yaml](../compose.prod.yaml).

---

## 1. Alokasi Memori Target (3 Container)

| Service | Batas RAM (`mem_limit`) | Peran |
| --- | --- | --- |
| `db` (`postgres:16-alpine`) | `256 MB` | Database buku kas (`shared_buffers=64MB`, `work_mem=2MB`, `max_connections=25`) |
| `api` (FastAPI + Uvicorn) | `384 MB` | API REST + WebSocket + Gemini Vision + subprocess PDF WeasyPrint |
| `caddy` (`caddy:2-alpine`) | `128 MB` | HTTPS otomatis + serve static PWA `/srv/web` + reverse proxy `/v1/*` |
| **Total batas** | **768 MB** | Nyaman di VPS 1 GB RAM (atau VPS 512 MB dengan swap 1 GB) |

> [!TIP]
> Pada VPS 512 MB – 1 GB RAM, **sangat disarankan mengaktifkan swap 1 GB** agar proses `docker compose build` (terutama build Next.js) tidak kehabisan memori.

---

## 2. Persiapan Awal di VPS (Ubuntu/Debian)

1. Pasang Docker Engine & Docker Compose plugin.
2. (Jika RAM VPS <= 1 GB) Aktifkan swap 1 GB:
   ```bash
   sudo fallocate -l 1G /swapfile
   sudo chmod 600 /swapfile
   sudo mkswap /swapfile
   sudo swapon /swapfile
   echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
   ```
3. Clone repositori dan siapkan `.env`:
   ```bash
   git clone <URL_REPO_ANDA> samsaku
   cd samsaku
   cp .env.example .env
   nano .env
   ```

### Isi Minimal `.env` untuk VPS Mandiri
```env
LOCAL_DB_PASSWORD=<string-acak-panjang-alfanumerik>
SAMSAKU_DEV_TOKEN=<password-akses-dashboard-anda>
SAMSAKU_DOMAIN=keuangan.domainanda.com
GEMINI_API_KEY=<api-key-google-ai-studio-anda>
GEMINI_MODEL=gemini-3.5-flash-lite
```
- Jika belum memakai domain (akses via IP), biarkan `SAMSAKU_DOMAIN=:80`.
- Jika memakai domain, arahkan DNS A-record ke IP VPS dan buka port TCP `80` serta `443` di firewall — Caddy akan mengurus sertifikat TLS Let's Encrypt otomatis.
- Jika ingin memakai Google/Email Login via Supabase, isi juga `OWNER_ID`, `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, dan `NEXT_PUBLIC_SUPABASE_ANON_KEY`.

---

## 3. Menjalankan & Memperbarui Aplikasi

### Build & Start Pertama Kali
```bash
docker compose -f compose.prod.yaml up -d --build
```
Container `api` otomatis menjalankan `alembic upgrade head` saat startup sebelum Uvicorn menerima trafik.

### Cek Kesehatan Container & Penggunaan RAM
```bash
docker compose -f compose.prod.yaml ps
docker stats --no-stream
curl -i http://localhost/health
```

### Update ke Versi Baru
```bash
git pull origin main
docker compose -f compose.prod.yaml up -d --build
docker image prune -f
```

---

## 4. Backup & Restore Database Terenkripsi

Skrip [ops/backup.py](../ops/backup.py) menghasilkan cadangan PostgreSQL terenkripsi GnuPG (`.gpg`).

### Backup dari Host VPS
```bash
docker compose -f compose.prod.yaml exec -T db \
  pg_dump -U samsaku -d samsaku -Fc \
  | gpg --symmetric --cipher-algo AES256 --output "samsaku-$(date +%F).dump.gpg"
```
Simpan file `.dump.gpg` di penyimpanan terpisah (Google Drive / laptop pribadi) dan simpan passphrase terpisah dari file cadangan.

### Uji Restore
```bash
gpg --decrypt samsaku-2026-11-26.dump.gpg \
  | docker compose -f compose.prod.yaml exec -T db \
    pg_restore -U samsaku -d samsaku --clean --if-exists --no-owner --no-privileges
```

---

## 5. Troubleshooting Umum

| Gejala | Penyebab Umum | Solusi |
| --- | --- | --- |
| Scan struk error `503` | `GEMINI_API_KEY` belum diisi di `.env` | Isi `GEMINI_API_KEY`, lalu `docker compose -f compose.prod.yaml up -d api` |
| Build Next.js terhenti (`Killed`) | RAM VPS terlalu kecil tanpa swap | Aktifkan swap 1 GB (Langkah 2) lalu jalankan ulang build |
| PDF gagal atau `504` | Rentang tanggal sangat besar / CPU VPS sibuk | Pilih rentang 1 bulan atau nonaktifkan opsi rincian transaksi |
| Dashboard tidak konek ke API | Token `SAMSAKU_DEV_TOKEN` salah atau `OWNER_ID` terisi tanpa Supabase | Cek `.env`, lalu lihat log via `docker compose -f compose.prod.yaml logs --tail=80 api` |
