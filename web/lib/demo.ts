import { Account, Category, Data, Transaction, expense, period, today } from "./domain";
const accounts: Account[] = [{ id: "bca", code: "BCA", name: "myBCA", balance: 6840000 }, { id: "gopay", code: "GOPAY", name: "GoPay", balance: 485000 }, { id: "cash", code: "CASH", name: "Tunai", balance: 320000 }];
const categories: Category[] = [["food", "Makan & minum"], ["shopping", "Belanja"], ["transport", "Transportasi"], ["bills", "Tagihan"], ["other", "Lainnya"]].map(([id, name]) => ({ id, code: id.toUpperCase(), name, kind: "expense" }));
categories.push({ id: "salary", code: "GAJI", name: "Gaji", kind: "income" });
export function demo(month: string): Data {
    const anchor = today().slice(0, 7), current = month === anchor, days = Number(period(month).end.slice(-2)), prev = new Date(anchor + "-01T12:00:00");
    prev.setDate(0);
    const previous = prev.getFullYear() + "-" + String(prev.getMonth() + 1).padStart(2, "0");
    const rows: [
        string,
        string,
        number,
        string,
        string,
        number
    ][] = [
        ["Gaji bulanan", "salary", 8500000, "bca", "income", .02],
        ["Belanja bulanan", "shopping", 810000, "bca", "expense", .05],
        ["Listrik dan air", "bills", 680000, "bca", "expense", .11],
        ["Pasar Minggu", "food", 470000, "cash", "expense", .18],
        ["Toko buku", "shopping", 260000, "gopay", "expense", .24],
        ["Isi bensin", "transport", 430000, "bca", "expense", .35],
        ["Warung Bu Siti", "food", 392000, "bca", "expense", .47],
        ["Kebutuhan rumah", "other", 380000, "bca", "expense", .55],
        ["Belanja dapur", "food", 615000, "cash", "expense", .67],
        ["Restoran Sederhana", "food", 328000, "bca", "expense", .76],
        ["Transportasi daring", "transport", 302000, "gopay", "expense", .86],
        ["GrabBike", "transport", 38000, "gopay", "expense", .95],
        ["Kopi Tuku", "food", 35000, "gopay", "expense", 1]
    ];
    const transactions: Transaction[] = (current || month === previous ? rows : []).map(([description, category_id, amount, account_id, k, x], i) => ({ id: "demo-" + i, date: month + "-" + String(Math.max(1, Math.round(x * days))).padStart(2, "0"), kind: k as Transaction["kind"], amount: current ? amount : Math.round(amount * .85), description, account_id, category_id, account_name: accounts.find(a => a.id === account_id)?.name, category_name: categories.find(c => c.id === category_id)?.name })).reverse();
    const income = transactions.reduce((s, t) => s + (t.kind === "income" ? t.amount : 0), 0), ex = transactions.reduce((s, t) => s + expense(t), 0);
    const bars = categories.filter(c => c.kind === "expense").map(c => ({ name: c.name, amount: transactions.filter(t => t.category_id === c.id).reduce((s, t) => s + expense(t), 0) })).filter(c => c.amount).sort((a, b) => b.amount - a.amount);
    return { accounts, categories, transactions, goals: [], schemes: [], reviews: [], summary: { income, expense: ex, net: income - ex, categories: bars, accounts, reviews: 0, transactions } };
}
