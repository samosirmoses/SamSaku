import unittest
from datetime import date
from io import BytesIO
from openpyxl import Workbook

from app.xlsx import WorkbookError, as_date, inspect, money, scan, template
from app.receipt_text import extract


class WorkbookTests(unittest.TestCase):
    def test_template_works_for_both_kinds(self):
        self.assertEqual([s["name"] for s in inspect(template("transactions"))], ["transactions","Petunjuk"])
        masters = inspect(template("masters"))
        self.assertIn("schemes", [s["name"] for s in masters])
        self.assertEqual(masters[0]["headers"][:2], ["code","name"])

    def test_custom_headers_and_calendar(self):
        book = Workbook()
        sheet = book.active
        sheet.title = "Arsip"
        sheet.append(["Bukti BCA November"])
        sheet.append(["Tgl","Uang keluar","Rincian lama"])
        sheet.append([date(2025,11,12), "Rp 42.000,00","Kopi"])
        stream = BytesIO()
        book.save(stream)
        rows = scan(stream.getvalue(), [{"name":"Arsip", "entity":"transactions", "header_row":2,
            "mapping":{"description":"Rincian lama"},"default_account":"BCA"}])
        self.assertEqual(rows[0]["row"], 3)
        self.assertEqual(rows[0]["values"], {"date":"2025-11-12","debit":"Rp 42.000,00","description":"Kopi","account":"BCA"})
        self.assertEqual(as_date("04/05/2025","DMY"),"2025-05-04")
        self.assertEqual(as_date("04/05/2025","MDY"),"2025-04-05")

    def test_currency_does_not_round_fractional_rupiah(self):
        self.assertEqual(money("Rp 42.000,00"), 42000)
        for invalid in ("1.250,50","1,234.50",float("nan"),True):
            with self.assertRaises(ValueError):
                money(invalid)

    def test_invalid_workbook(self):
        with self.assertRaises(WorkbookError):
            inspect(b"workbook")

    def test_receipt_uses_total_and_leaves_ambiguous_amount_for_review(self):
        text = "Kopi Senja\n12/11/2026\nSubtotal Rp40.000\nTOTAL Rp42.000\nTunai Rp50.000\nKembali Rp8.000"
        self.assertEqual(extract(text), {"amount":42000,"date":"2026-11-12","merchant":"Kopi Senja","amount_options":[42000]})
        self.assertIsNone(extract(text + "\nTotal Rp43.000")["amount"])


if __name__ == "__main__":
    unittest.main()
