# SamSaku

Aplikasi keuangan pribadi berbahasa Indonesia untuk mencatat transaksi, memindai struk dengan Gemini Vision AI, mengimpor Excel, memantau anggaran & statistik, serta menarik laporan PDF/CSV. Dirancang **ringan, cepat, dan hemat RAM** untuk berjalan mandiri di VPS murah (512 MB – 2 GB RAM) via Docker Compose.

## Peta Dokumentasi

Semua spesifikasi, arsitektur, kontrak API, skema database, dan panduan operasional VPS terdokumentasi rapi di repositori ini:

| Dokumen | Isi |
| --- | --- |
| [SPEC.md](SPEC.md) | **Living Spec** — seluruh aturan pembukuan, fitur produk, dan roadmap. |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Struktur folder berlapis (Backend & Frontend), diagram alur data, dan strategi efisiensi RAM/CPU. |
| [docs/DATABASE.md](docs/DATABASE.md) | Diagram ERD PostgreSQL, penjelasan tabel, constraint, dan index performa. |
| [docs/API.md](docs/API.md) | Ringkasan endpoint `/v1/*` dan WebSocket + snapshot otomatis [docs/openapi.json](docs/openapi.json). |
| [docs/VPS_DEPLOYMENT.md](docs/VPS_DEPLOYMENT.md) | Panduan step-by-step deploy ke VPS murah (3 container), HTTPS Caddy, backup/restore, dan troubleshooting. |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | Riwayat perubahan versi aplikasi. |
| [AGENTS.md](AGENTS.md) | Aturan wajib bagi AI agent agar struktur kode, efisiensi VPS, dan dokumen selalu sinkron. |

---

## Menjalankan Secara Lokal

Prasyarat: Docker Desktop (Linux containers). Dari PowerShell di root repositori:

```powershell
.\ops\init-local.ps1
docker compose up --build
```

- Dashboard lokal: `http://localhost:3000` (pilih hubungkan server lalu masukkan nilai `SAMSAKU_DEV_TOKEN` dari `.env`).
- Dokumentasi API interaktif: `http://localhost:8000/docs`.
- Untuk produksi di VPS murah (3 container: `db`, `api`, `caddy`), ikuti panduan lengkap di [docs/VPS_DEPLOYMENT.md](docs/VPS_DEPLOYMENT.md).

---

## Ringkasan Stack Teknologi

| Bagian | Implementasi |
| --- | --- |
| **Frontend PWA** | `web/` — Next.js 16 static export, React 19, TypeScript, CSS modular (`styles/`), lazy-loading per fitur (`next/dynamic`), DM Sans. |
| **Backend API** | `backend/` — FastAPI berlapis (`core/`, `models/`, `schemas/`, `services/`, `routers/`), SQLAlchemy 2.0, Alembic, PostgreSQL 16. |
| **Dokumen & AI** | `openpyxl` (Excel), Gemini Vision API (scan struk, tanpa Tesseract lokal), Jinja2 + WeasyPrint dalam subprocess terisolasi (PDF). |
| **Edge & Proxy** | Caddy 2 (`ops/Caddyfile`) — HTTPS otomatis, kompresi `zstd`/`gzip`, melayani static PWA + reverse proxy `/v1/*`. |
| **Konektor** | `connectors/gmail/` (Apps Script mutasi BCA), `android/` (APK notifikasi GoPay/Gojek), Webhook/Poller Telegram. |

---

## Perintah Verifikasi

```text
backend/   python -m pytest
repo/      python ops/export_openapi.py --check
web/       npm run typecheck && npm run build
repo/      node --test connectors/gmail/tests/sync.test.cjs
android/   gradle :app:assembleDebug
```

Workflow GitHub Actions [verify.yml](.github/workflows/verify.yml) berjalan otomatis pada setiap `push` dan `pull_request` ke `main` untuk memverifikasi migrasi PostgreSQL, pengujian backend & sinkronisasi OpenAPI, uji backup/restore, konektor Gmail, build PWA, dan build APK Android.
