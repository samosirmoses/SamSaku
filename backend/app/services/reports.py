"""CSV and memory-isolated WeasyPrint PDF report generation."""
import csv
from datetime import date
import io
import multiprocessing
import queue
import threading

from fastapi import HTTPException
from jinja2 import Environment

PDF_TIMEOUT_SECONDS = 30
PDF_LOCK_TIMEOUT_SECONDS = 0.25
MAX_PDF_SPAN_DAYS = 366
MAX_PDF_DETAIL_ROWS = 500
_PDF_SEMAPHORE = threading.BoundedSemaphore(1)

_PDF_TEMPLATE = """<!DOCTYPE html><html lang="id"><meta charset="utf-8"><title>Laporan SamSaku</title>
<style>
@page { size:A4; margin:19mm 16mm; @bottom-right {content:counter(page) " / " counter(pages); color:#656962;font-size:9pt} }
body{font:10pt "DejaVu Sans",sans-serif;color:#202722}header{border-bottom:2px solid #A88955;padding-bottom:7mm}
h1,h2{font-family:"DejaVu Serif",serif;color:#183D35;font-weight:normal}h1{font-size:29pt;margin:0}h2{margin-top:9mm}
table{border-collapse:collapse;width:100%}th,td{text-align:left;border-bottom:1px solid #dcded7;padding:2.8mm 1mm}
th{color:#183D35}thead{display:table-header-group}tr{break-inside:avoid}td.num,th.num{text-align:right;white-space:nowrap}
p{line-height:1.6}small{color:#656962}
</style><header><h1>SamSaku</h1><p>Laporan keuangan pribadi · {{ start }} – {{ end }}</p></header>
<h2>Arus kas</h2><table><tr><th>Pemasukan</th><th>Pengeluaran bersih</th><th>Selisih</th></tr>
<tr><td>{{ income|idr }}</td><td>{{ expense|idr }}</td><td>{{ net|idr }}</td></tr></table>
{% if reviews %}<p>{{ reviews }} bukti menunggu tinjauan.</p>{% endif %}
{% if partial_history %}<p>Riwayat sebagian · periode mencakup transaksi sebelum saldo acuan.</p>{% endif %}
<h2>Pengeluaran per kategori</h2><table><thead><tr><th>Kategori</th><th class="num">Jumlah</th></tr></thead>
<tbody>{% for c in categories %}<tr><td>{{ c.name }}</td><td class="num">{{ c.amount|idr }}</td></tr>
{% else %}<tr><td colspan="2">Belum ada pengeluaran pada periode ini.</td></tr>{% endfor %}</tbody></table>
{% if details %}<h2>Rincian transaksi</h2><table><thead><tr><th>Tanggal</th><th>Transaksi</th><th>Dompet</th><th class="num">Nominal</th></tr></thead>
<tbody>{% for t in transactions %}<tr><td>{{ t.date }}</td><td>{{ t.description or kinds[t.kind] }}<br><small>{{ kinds[t.kind] }}{% if t.fee %} · Biaya {{ t.fee|idr }}{% endif %}</small></td>
<td>{{ t.account_name }}</td><td class="num">{{ t.amount|idr }}</td></tr>{% else %}<tr><td colspan="4">Belum ada transaksi.</td></tr>{% endfor %}</tbody></table>{% endif %}</html>"""


def safe_cell(value):
    if isinstance(value, str) and (
        value.startswith(("=", "+", "-", "@", "\t", "\r")) or value.lstrip().startswith(("=", "+", "-", "@"))
    ):
        return "'" + value
    return value


def csv_bytes(rows) -> bytes:
    stream = io.StringIO(newline="")
    writer = csv.writer(stream)
    writer.writerows([safe_cell(value) for value in row] for row in rows)
    return stream.getvalue().encode("utf-8-sig")


def report_csv(report: dict) -> bytes:
    rows = [
        [
            "Tanggal",
            "Jenis",
            "Dompet",
            "Keterangan",
            "Kategori",
            "Nominal (IDR)",
            "Biaya admin (IDR)",
            "Pemasukan (IDR)",
            "Pengeluaran bersih (IDR)",
            "Sumber",
        ]
    ]
    for tx in report["transactions"]:
        income = sum(a["amount"] for a in tx["splits"] if a["role"] == "income")
        expense = sum(a["amount"] for a in tx["splits"] if a["role"] != "income")
        rows.append(
            [
                tx["date"],
                tx["kind"],
                tx["account_name"],
                tx["description"],
                tx["category_name"],
                tx["amount"],
                tx["fee"],
                income,
                expense,
                tx["source"],
            ]
        )
    return csv_bytes(rows)


def rupiah(amount: int) -> str:
    return ("−" if amount < 0 else "") + "Rp" + format(abs(amount), ",").replace(",", ".")


def _render_html(report: dict, details: bool) -> str:
    env = Environment(autoescape=True)
    env.filters["idr"] = rupiah
    return env.from_string(_PDF_TEMPLATE).render(
        **report,
        details=details,
        kinds={"expense": "Pengeluaran", "income": "Pemasukan", "transfer": "Transfer", "refund": "Refund"},
    )


def _pdf_worker(html: str, result_queue) -> None:
    try:
        from weasyprint import HTML

        result_queue.put(("ok", HTML(string=html).write_pdf()))
    except Exception as exc:
        result_queue.put(("err", str(exc)))


def report_pdf(report: dict, details: bool) -> bytes:
    """Render PDF in an isolated spawn subprocess with strict concurrency and row bounds."""
    start = report.get("start")
    end = report.get("end")
    if isinstance(start, str):
        start = date.fromisoformat(start)
    if isinstance(end, str):
        end = date.fromisoformat(end)
    if isinstance(start, date) and isinstance(end, date) and (end - start).days > MAX_PDF_SPAN_DAYS:
        raise HTTPException(
            422,
            f"Rentang tanggal PDF maksimal {MAX_PDF_SPAN_DAYS + 1} hari. Gunakan ekspor CSV untuk rentang lebih panjang.",
        )
    if details and len(report.get("transactions", ())) > MAX_PDF_DETAIL_ROWS:
        raise HTTPException(
            422,
            f"Rincian transaksi PDF dibatasi maksimal {MAX_PDF_DETAIL_ROWS} baris. Nonaktifkan rincian atau ekspor CSV.",
        )
    if not _PDF_SEMAPHORE.acquire(timeout=PDF_LOCK_TIMEOUT_SECONDS):
        raise HTTPException(429, "Laporan PDF lain sedang diproses. Tunggu beberapa detik lalu coba lagi.")
    try:
        html = _render_html(report, details)
        ctx = multiprocessing.get_context("spawn")
        result_queue = ctx.Queue(maxsize=1)
        proc = ctx.Process(target=_pdf_worker, args=(html, result_queue), daemon=True)
        proc.start()
        try:
            status, payload = result_queue.get(timeout=PDF_TIMEOUT_SECONDS)
        except queue.Empty:
            proc.terminate()
            proc.join(timeout=5)
            raise HTTPException(504, "Pembuatan PDF melebihi batas waktu. Coba rentang tanggal lebih pendek.")
        finally:
            proc.join(timeout=5)
            if proc.is_alive():
                proc.kill()
                proc.join(timeout=2)
            result_queue.close()
        if status != "ok":
            raise HTTPException(503, f"Gagal membuat PDF: {payload}")
        return payload
    finally:
        _PDF_SEMAPHORE.release()
