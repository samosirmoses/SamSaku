import csv
import io
from jinja2 import Environment


def safe_cell(value):
    if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@", "\t", "\r")):
        return "'" + value
    return value


def csv_bytes(rows):
    stream = io.StringIO(newline="")
    writer = csv.writer(stream)
    writer.writerows([safe_cell(value) for value in row] for row in rows)
    return stream.getvalue().encode("utf-8-sig")


def report_csv(report):
    rows = [["Tanggal", "Jenis", "Dompet", "Keterangan", "Kategori", "Nominal (IDR)", "Biaya admin (IDR)", "Pemasukan (IDR)", "Pengeluaran bersih (IDR)", "Sumber"]]
    for tx in report["transactions"]:
        income = sum(a["amount"] for a in tx["splits"] if a["role"] == "income")
        expense = sum(a["amount"] for a in tx["splits"] if a["role"] != "income")
        rows.append([tx["date"], tx["kind"], tx["account_name"], tx["description"], tx["category_name"],
                     tx["amount"], tx["fee"], income, expense, tx["source"]])
    return csv_bytes(rows)


def rupiah(amount):
    return ("−" if amount < 0 else "") + "Rp" + format(abs(amount), ",").replace(",", ".")


def report_pdf(report, details):
    from weasyprint import HTML
    env = Environment(autoescape=True)
    env.filters["idr"] = rupiah
    html = env.from_string("""<!DOCTYPE html><html lang="id"><meta charset="utf-8"><title>Laporan SamSaku</title>
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
<td>{{ t.account_name }}</td><td class="num">{{ t.amount|idr }}</td></tr>{% else %}<tr><td colspan="4">Belum ada transaksi.</td></tr>{% endfor %}</tbody></table>{% endif %}</html>""").render(
        **report, details=details, kinds={"expense":"Pengeluaran", "income":"Pemasukan", "transfer":"Transfer","refund":"Refund"})
    return HTML(string=html).write_pdf()
