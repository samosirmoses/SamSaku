"""Excel file inspection and normalization independent of database and web framework."""
import re
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from io import BytesIO
from zipfile import BadZipFile, ZipFile
from xml.etree.ElementTree import ParseError

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill


class WorkbookError(ValueError):
    pass


FIELDS = {
    "transactions": "date kind account amount debit credit description category to_account fee reference merchant original_ref",
    "accounts": "code name kind opening_date opening_balance",
    "categories": "code name kind parent",
    "merchants": "code name",
    "aliases": "name merchant",
    "schemes": "code name cycle_day",
    "pots": "scheme name mode value category",
}
FIELDS = {key: value.split() for key, value in FIELDS.items()}
ORDER = ["accounts", "categories", "merchants", "aliases", "schemes", "pots", "transactions"]
HEADERS = {
    "date": "tanggal|tgl|tanggal transaksi", "kind": "jenis|tipe|jenis transaksi",
    "account": "dompet|rekening|akun", "amount": "nominal|jumlah|nilai",
    "debit": "debet|keluar|uang keluar", "credit": "kredit|masuk|uang masuk",
    "category": "kategori", "description": "keterangan|catatan|deskripsi|uraian",
    "to_account": "tujuan|dompet tujuan", "fee": "biaya|biaya admin",
    "reference": "referensi|no referensi|id transaksi", "merchant": "toko",
    "original_ref": "referensi asal", "code": "kode", "name": "nama",
    "opening_date": "tanggal saldo awal", "opening_balance": "saldo awal",
    "parent": "induk", "cycle_day": "tanggal mulai", "scheme": "skema",
    "mode": "aturan", "value": "nilai aturan",
}
KINDS = {"pemasukan": "income", "pengeluaran": "expense", "pengembalian": "refund"}


def norm(value):
    return str(value or "").strip().casefold()


def safe_value(value):
    if isinstance(value, (date, datetime)):
        return value.isoformat()[:10]
    if isinstance(value, str):
        if len(value) > 2048:
            raise WorkbookError("Isi sel terlalu panjang.")
        return value.strip()
    return value


def workbook(data):
    try:
        with ZipFile(BytesIO(data)) as archive:
            if sum(i.file_size for i in archive.infolist()) > 32 * 1024 * 1024:
                raise ValueError("Workbook terlalu besar setelah dibuka.")
        book = load_workbook(BytesIO(data), read_only=True, data_only=True, keep_links=False)
    except (BadZipFile, KeyError, OSError, ValueError, ParseError) as err:
        raise WorkbookError("Workbook XLSX tidak valid atau terlalu besar.") from err
    if len(book.sheetnames) > 40:
        book.close()
        raise WorkbookError("Maksimum 40 sheet per workbook.")
    return book


def cells(ws, start, end):
    if (ws.max_column or 0) > 128:
        raise WorkbookError(f"Sheet {ws.title} melebihi batas 128 kolom.")
    # Some Excel exporters record A1 as the dimension of an entire worksheet.
    # Stream the actual cells, including those outside that stale declaration.
    ws.reset_dimensions()
    for row in ws.iter_rows(min_row=start, max_row=end, values_only=True):
        if len(row) > 128:
            raise WorkbookError(f"Sheet {ws.title} melebihi batas 128 kolom.")
        yield row


def inspect(data):
    book = workbook(data)
    result = []
    try:
        for ws in book:
            sample = [[safe_value(v) for v in row] for row in cells(ws, 1, 6)]
            headers = [str(x or "") for x in sample[0]] if sample else []
            result.append({"name": ws.title, "headers": headers, "sample": sample})
        return result
    finally:
        book.close()


def template(kind):
    book = Workbook()
    book.remove(book.active)
    for entity in (["transactions"] if kind == "transactions" else ORDER[:-1]):
        ws = book.create_sheet(entity)
        ws.append(FIELDS[entity])
        ws.freeze_panes = "A2"
        for cell in ws[1]:
            cell.font = Font(bold=True, color="FFFFFF")
            cell.fill = PatternFill("solid", fgColor="183D35")
            ws.column_dimensions[cell.column_letter].width = 21
    guide = book.create_sheet("Petunjuk")
    guide.append(["SamSaku • petunjuk"])
    guide.append(["Tanggal: YYYY-MM-DD. Masukkan nominal dalam rupiah bulat."])
    guide.append(["Contoh transaksi: 2026-01-13 | expense | BCA01 | 35000"])
    guide.append(["Gunakan kode atau nama dompet, kategori dan merchant yang unik."])
    guide.append(["Jenis transaksi: income, expense, transfer, refund. Sheet Petunjuk tidak diimpor."])
    guide.append(["Aturan pos: fixed (rupiah), percent (0–100), remainder (sisa)."])
    guide.column_dimensions["A"].width = 110
    buffer = BytesIO()
    book.save(buffer)
    return buffer.getvalue()


def money(value, signed=False):
    if isinstance(value, bool) or value is None:
        raise ValueError("Nominal wajib berupa rupiah bulat.")
    if isinstance(value, str):
        s = re.sub(r"(?i)^rp\.?\s*", "", value).strip().replace(" ", "")
        if not re.fullmatch(r"-?(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d+)?", s):
            raise ValueError("Format nominal tidak dikenali. Gunakan angka atau format Indonesia.")
        value = s.replace(".", "").replace(",", ".")
    try:
        number = Decimal(str(value))
        if not number.is_finite() or abs(number) > 9_000_000_000_000_000:
            raise ValueError("Nominal di luar batas.")
        units = int(number)
    except (InvalidOperation, OverflowError) as err:
        raise ValueError("Nominal tidak valid.") from err
    if number != units or (units < 0 and not signed):
        raise ValueError("Gunakan rupiah bulat dengan tanda yang sesuai.")
    return units


def as_date(value, order):
    raw = str(value or "").strip()
    try:
        return date.fromisoformat(raw).isoformat()
    except ValueError:
        pass
    for sep in ("/", "-"):
        fmt = {"DMY": sep.join(("%d","%m","%Y")), "MDY":sep.join(("%m","%d","%Y")),
               "YMD":sep.join(("%Y","%m","%d"))}[order]
        try:
            return datetime.strptime(raw, fmt).date().isoformat()
        except ValueError:
            continue
    raise ValueError("Tanggal tidak valid. Pilih urutan tanggal atau gunakan YYYY-MM-DD.")


def scan(data, plans):
    book = workbook(data)
    rows = []
    try:
        for plan in plans:
            name, entity = plan["name"], plan["entity"]
            if name not in book.sheetnames or entity not in FIELDS:
                raise WorkbookError("Sheet atau jenis data tidak dikenali.")
            ws = book[name]
            start = plan.get("header_row", 1)
            headers = [str(h or "").strip() for h in next(cells(ws, start, start), ())]
            mapping = plan.get("mapping", {})
            columns = {}
            for key in FIELDS[entity]:
                names = [key, *HEADERS.get(key, "").split("|")]
                if key in mapping:
                    names = [mapping[key]]
                matches = [idx for idx, h in enumerate(headers) if h and norm(h) in {norm(n) for n in names}]
                if len(matches) > 1:
                    raise WorkbookError(f"Kolom untuk {key} ambigu pada {name}. Pilih satu judul unik.")
                if matches:
                    columns[key] = matches[0]
            if not columns:
                raise WorkbookError(f"Tidak ada kolom yang cocok pada {name}.")
            if (ws.max_row or 0) > start + 10001:
                raise WorkbookError("Pecah sheet menjadi maksimal 10.000 baris.")
            for index, raw in enumerate(cells(ws, start + 1, None), start + 1):
                if index > start + 10000:
                    raise WorkbookError("Pecah sheet menjadi maksimal 10.000 baris.")
                if not any(v is not None and v != "" for v in raw):
                    continue
                values = {key: safe_value(raw[col]) for key, col in columns.items() if col < len(raw) and raw[col] not in (None, "")}
                if entity == "transactions" and not values.get("account") and plan.get("default_account"):
                    values["account"] = plan["default_account"]
                rows.append({"sheet": name, "row": index, "entity": entity, "values": values, "order": plan.get("date_order", "DMY"),
                             "categories":plan.get("categories", {})})
                if len(rows) > 10000:
                    raise WorkbookError("Maksimum 10.000 baris per batch.")
        # Parents may be located below a child in an imported category sheet.
        return sorted(rows, key=lambda r: (ORDER.index(r["entity"]), bool(r["values"].get("parent"))))
    finally:
        book.close()

