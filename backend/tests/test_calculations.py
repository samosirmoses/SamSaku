from datetime import date
from unittest import TestCase

from app.calculations import cycle, divide, rupiah


class MoneyRules(TestCase):
    def test_whole_idr_and_aliases(self):
        for text, amount in [("Rp 35.000,00",35000),("35k",35000),("2jt",2000000),("1500,50",None),
                             ("1..25",None),("Rp 20.00",None)]:
            with self.subTest(text=text):
                self.assertEqual(rupiah(text), amount)

    def test_salary_cycle_short_month(self):
        self.assertEqual(cycle(31,date(2026,2,27)),(date(2026,1,31),date(2026,2,28)))
        self.assertEqual(cycle(31,date(2026,2,28)),(date(2026,2,28),date(2026,3,31)))
        self.assertEqual(cycle(25,date(2026,1,24)),(date(2025,12,25),date(2026,1,25)))

    def test_gaji_bonus_and_overdraw(self):
        rules = [{"name":n,"mode":m,"value":v} for n,m,v in [
            ("Keluarga","fixed",1500000),("Darurat","percent",20),("Harian","percent",45),("Bebas","remainder",0)]]
        self.assertEqual(divide(8000000,rules,{}), ([1500000,1600000,3600000,1300000],0))
        self.assertEqual(divide(100001,rules,{"Keluarga":1500000}),([0,20000,45000,35001],0))
        self.assertLess(divide(100000,rules,{})[1],0)
