# Aturan Kerja AI Agent — SamSaku

Dokumen ini berlaku wajib untuk setiap sesi AI agent yang memodifikasi repositori **SamSaku**. Pemilik proyek menjalankan workflow *less-coding* dan bergantung pada dokumentasi yang selalu sinkron, arsitektur yang bersih, serta efisiensi tinggi untuk VPS murah (512 MB – 2 GB RAM).

---

## 1. Aturan Wajib Living Spec & Dokumentasi (Anti-Drift)

Setiap perubahan fitur, endpoint API, skema database, perilaku UI, atau konfigurasi deployment **BELUM BOLEH dianggap selesai** sebelum hal berikut diperbarui dalam perubahan yang sama:

1. **`SPEC.md`**: Perbarui aturan bisnis, perilaku fitur, atau daftar kapabilitas jika ada perubahan fungsional.
2. **`docs/openapi.json` & `docs/API.md`**: Setiap perubahan route, parameter, atau Pydantic schema wajib mengekspor ulang OpenAPI via `python ops/export_openapi.py` dan memperbarui ringkasan di `docs/API.md`.
3. **`docs/DATABASE.md`**: Wajib diperbarui setiap kali menambah/mengubah tabel, kolom, constraint, atau index Alembic.
4. **`docs/ARCHITECTURE.md`**: Wajib diperbarui jika menambah modul, mengubah alur data, atau mengubah struktur folder.
5. **`docs/VPS_DEPLOYMENT.md`**: Wajib diperbarui jika mengubah environment variable, `compose.prod.yaml`, `Caddyfile`, atau prosedur backup/deploy.
6. **`docs/CHANGELOG.md`**: Tambahkan entri ringkas (Bahasa Indonesia) di bagian paling atas untuk setiap perubahan bermakna.

---

## 2. Standar Arsitektur Kode

### Backend (`backend/app/`)
- Pertahankan arsitektur berlapis: `core/`, `models/`, `schemas/`, `services/`, `routers/`.
- **Dilarang** menaruh query database kompleks atau logika bisnis langsung di `routers/` atau `main.py` — letakkan di `services/`.
- Gunakan SQLAlchemy 2.0 `Mapped` / `mapped_column` untuk semua model baru.
- **Pertahankan kompatibilitas `/v1/*`** agar APK Android (`android/`), Google Apps Script (`connectors/gmail/`), dan webhook Telegram tidak rusak.

### Frontend (`web/`)
- Pertahankan struktur modular: `hooks/`, `components/ui/`, `components/layout/`, `features/<domain>/`, `lib/`, `styles/`.
- **Dilarang** membuat file monolitik baru di `app/page.tsx` atau menumpuk seluruh fitur dalam satu file.
- Gunakan `next/dynamic` untuk lazy-loading halaman/modal non-utama dan dynamic `import("./demo")` agar mode sandbox tidak ikut terunduh oleh pengguna yang sudah login.
- **Jangan menambahkan kembali** Tailwind CSS atau font yang tidak terpakai; letakkan styling pada file modular di `web/styles/`.

---

## 3. Batasan Performa & Efisiensi VPS Murah (512 MB – 2 GB RAM)

1. **Anti N+1 Query**: Operasi list/summary harus memakai batch query (`IN (...)` atau `GROUP BY`) dalam kompleksitas O(1) jumlah query.
2. **Dilarang memakai `lock_owner` pada endpoint `GET` (read-only)**: Advisory lock hanya boleh dipakai untuk operasi tulis (`POST`, `PUT`, `PATCH`, `DELETE`).
3. **Gunakan `GET /v1/bootstrap`** untuk pemuatan awal/refresh dashboard agar frontend hanya mengirim 1 HTTP request, bukan banyak request paralel.
4. **Hemat RAM untuk fitur berat**:
   - **Jangan memasang kembali Tesseract OCR lokal** di Docker image backend; scan struk hanya menggunakan Gemini Vision API.
   - **WeasyPrint PDF wajib tetap berjalan di subprocess terisolasi** (`multiprocessing` `spawn`) agar memori Pango/Cairo langsung dikembalikan ke OS setelah selesai.
   - Gunakan `core/http_client.py` (shared `httpx.Client`) untuk panggilan HTTP eksternal.
5. **Infrastruktur produksi (`compose.prod.yaml`)**: Pertahankan konfigurasi hemat 3 container (`db`, `api`, `caddy`) dengan tuning RAM PostgreSQL dan `mem_limit`.

---

## 4. Aturan Git & Verifikasi

- **WAJIB konfirmasi eksplisit kepada pemilik sebelum menjalankan `git push`** (dan sebelum melakukan operasi git destruktif).
- Sebelum melaporkan selesai, wajib menjalankan verifikasi berikut tanpa error:
  1. `python -m pytest` di `backend/` (termasuk `test_performance.py` dan `test_docs_sync.py`)
  2. `alembic upgrade head` (jika ada migrasi baru)
  3. `npm run typecheck && npm run build` di `web/`
  4. `node --test connectors/gmail/tests/sync.test.cjs`
