import {
    Account,
    Budget,
    Category,
    Data,
    Settings,
    Summary,
    Transaction,
    expense,
    inferCategoryClient,
    period,
    shiftMonth,
    today,
} from "./domain";

const STORAGE_KEY = "samsaku-demo-store-v2";

type DemoStore = {
    accounts: Account[];
    categories: Category[];
    transactions: Transaction[];
    budgetSpecs: { id: string; category_id: string; amount: number }[];
    settings: Settings;
};

function initialStore(): DemoStore {
    const anchor = today().slice(0, 7);
    const prev = shiftMonth(anchor, -1);
    const accounts: Account[] = [
        {
            id: "bca",
            code: "BCA",
            name: "myBCA",
            kind: "bank",
            opening_date: "2026-01-01",
            opening_balance: 5000000,
            balance: 6840000,
        },
        {
            id: "gopay",
            code: "GOPAY",
            name: "GoPay",
            kind: "ewallet",
            opening_date: "2026-01-01",
            opening_balance: 500000,
            balance: 485000,
        },
        {
            id: "cash",
            code: "CASH",
            name: "Tunai",
            kind: "cash",
            opening_date: "2026-01-01",
            opening_balance: 500000,
            balance: 320000,
        },
    ];

    const categories: Category[] = [
        { id: "food", code: "FOOD", name: "Makan & minum", kind: "expense" },
        { id: "shopping", code: "SHOPPING", name: "Belanja", kind: "expense" },
        { id: "transport", code: "TRANSPORT", name: "Transportasi", kind: "expense" },
        { id: "bills", code: "BILLS", name: "Tagihan", kind: "expense" },
        { id: "other", code: "OTHER", name: "Lainnya", kind: "expense" },
        { id: "salary", code: "GAJI", name: "Gaji", kind: "income" },
        { id: "bonus", code: "BONUS", name: "Bonus & freelance", kind: "income" },
    ];

    const budgetSpecs = [
        { id: "b-food", category_id: "food", amount: 2000000 },
        { id: "b-shopping", category_id: "shopping", amount: 1200000 },
        { id: "b-transport", category_id: "transport", amount: 850000 },
        { id: "b-bills", category_id: "bills", amount: 800000 },
        { id: "b-other", category_id: "other", amount: 500000 },
    ];

    const settings: Settings = {
        monthly_start_day: 1,
        weekly_start_day: 1,
        default_account_id: "bca",
    };

    const seedRows: [string, string, number, string, Transaction["kind"], number, string?][] = [
        ["Gaji bulanan", "salary", 8500000, "bca", "income", 0.03],
        ["Project desain UI", "bonus", 1500000, "bca", "income", 0.38],
        ["Top up GoPay dari BCA", "", 500000, "bca", "transfer", 0.06, "gopay"],
        ["Belanja bulanan Superindo", "shopping", 810000, "bca", "expense", 0.08],
        ["Listrik PLN dan air", "bills", 680000, "bca", "expense", 0.14],
        ["Pasar Minggu", "food", 470000, "cash", "expense", 0.21],
        ["Toko buku Gramedia", "shopping", 260000, "gopay", "expense", 0.27],
        ["Isi bensin Pertamax", "transport", 430000, "bca", "expense", 0.36],
        ["Warung Bu Siti", "food", 392000, "bca", "expense", 0.48],
        ["Kebutuhan rumah tangga", "other", 380000, "bca", "expense", 0.56],
        ["Belanja dapur segar", "food", 615000, "cash", "expense", 0.67],
        ["Restoran Sederhana", "food", 328000, "bca", "expense", 0.76],
        ["Transportasi daring GoRide", "transport", 302000, "gopay", "expense", 0.85],
        ["GrabBike ke stasiun", "transport", 38000, "gopay", "expense", 0.92],
        ["Kopi Tuku", "food", 35000, "gopay", "expense", 0.97],
    ];

    const transactions: Transaction[] = [];
    for (const [m, factor] of [
        [prev, 0.88],
        [anchor, 1],
    ] as const) {
        const { start, end } = period(m, 1);
        const startMs = new Date(start + "T12:00:00").getTime();
        const endMs = new Date(end + "T12:00:00").getTime();
        const spanDays = Math.max(1, Math.round((endMs - startMs) / 86400000));
        seedRows.forEach(([description, category_id, amount, account_id, k, ratio, to_account_id], i) => {
            const dayOffset = Math.min(spanDays, Math.max(0, Math.round(ratio * spanDays)));
            const d = new Date(startMs + dayOffset * 86400000);
            const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
            transactions.push({
                id: `demo-${m}-${i}`,
                date: iso,
                kind: k,
                amount: Math.round((amount * factor) / 1000) * 1000,
                fee: k === "transfer" ? 1000 : 0,
                description,
                account_id,
                to_account_id: to_account_id || null,
                category_id: category_id || null,
                source: "demo",
            });
        });
    }

    return { accounts, categories, transactions, budgetSpecs, settings };
}

function loadStore(): DemoStore {
    if (typeof window === "undefined") return initialStore();
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as DemoStore;
            if (parsed && Array.isArray(parsed.accounts) && Array.isArray(parsed.transactions)) {
                return parsed;
            }
        }
    } catch {}
    const fresh = initialStore();
    saveStore(fresh);
    return fresh;
}

function saveStore(store: DemoStore) {
    if (typeof window === "undefined") return;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch {}
}

export function resetDemoStore() {
    const fresh = initialStore();
    saveStore(fresh);
    return fresh;
}

function computeAccounts(store: DemoStore, asOf?: string): Account[] {
    return store.accounts.map(a => {
        const txCount = store.transactions.filter(
            t => t.account_id === a.id || t.to_account_id === a.id
        ).length;
        if (a.opening_balance == null || !a.opening_date) {
            return { ...a, balance: a.balance ?? null, tx_count: txCount };
        }
        let bal = a.opening_balance;
        for (const t of store.transactions) {
            if (t.date < a.opening_date) continue;
            if (asOf && t.date > asOf) continue;
            if (t.kind === "transfer") {
                if (t.account_id === a.id) bal -= t.amount + (t.fee || 0);
                if (t.to_account_id === a.id) bal += t.amount;
            } else if (t.account_id === a.id) {
                if (t.kind === "income" || t.kind === "refund") bal += t.amount;
                else bal -= t.amount;
            }
        }
        return { ...a, balance: bal, tx_count: txCount };
    });
}

function decorateTx(t: Transaction, store: DemoStore): Transaction {
    const acc = store.accounts.find(a => a.id === t.account_id);
    const toAcc = t.to_account_id ? store.accounts.find(a => a.id === t.to_account_id) : null;
    const cat = t.category_id ? store.categories.find(c => c.id === t.category_id) : null;
    const decoratedSplits = t.splits?.map(s => ({
        ...s,
        category_name:
            s.role === "fee"
                ? "Biaya admin"
                : store.categories.find(c => c.id === s.category_id)?.name || "Belum dikategorikan",
    }));
    const splitNames = decoratedSplits
        ?.filter(s => s.role !== "fee" && s.category_name)
        .map(s => s.category_name!);
    return {
        ...t,
        account_name: acc?.name || "Dompet",
        to_account_name: toAcc?.name || null,
        category_name: cat?.name || (splitNames?.length ? splitNames.join(" + ") : null),
        splits: decoratedSplits,
    };
}

function computeBudgets(store: DemoStore, start: string, end: string): Budget[] {
    const inRange = store.transactions.filter(t => t.date >= start && t.date <= end);
    return store.budgetSpecs
        .map(b => {
            const cat = store.categories.find(c => c.id === b.category_id);
            if (!cat) return null;
            const childIds = store.categories.filter(c => c.parent_id === cat.id).map(c => c.id);
            const targetIds = new Set([cat.id, ...childIds]);
            const spent = Math.max(
                0,
                inRange
                    .filter(t => {
                        if (t.splits?.length) {
                            return t.splits.some(s => s.category_id && targetIds.has(s.category_id));
                        }
                        return t.category_id ? targetIds.has(t.category_id) : false;
                    })
                    .reduce((sum, t) => {
                        if (t.splits?.length) {
                            return (
                                sum +
                                t.splits
                                    .filter(s => s.category_id && targetIds.has(s.category_id))
                                    .reduce((acc, s) => acc + s.amount, 0)
                            );
                        }
                        return sum + expense(t);
                    }, 0)
            );
            const remaining = b.amount - spent;
            const percent = b.amount > 0 ? Math.round((100 * spent) / b.amount) : 0;
            const status: Budget["status"] =
                spent > b.amount ? "over" : spent >= b.amount * 0.8 ? "warning" : "safe";
            return {
                id: b.id,
                category_id: b.category_id,
                category_name: cat.name,
                amount: b.amount,
                spent,
                remaining,
                percent,
                status,
            };
        })
        .filter((b): b is Budget => b !== null)
        .sort((a, b) => b.percent - a.percent);
}

function computeSummary(store: DemoStore, start: string, end: string): Summary {
    const txs = store.transactions
        .filter(t => t.date >= start && t.date <= end)
        .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id))
        .map(t => decorateTx(t, store));

    const inc = txs.reduce((s, t) => s + (t.kind === "income" ? t.amount : 0), 0);
    const ex = txs.reduce((s, t) => s + expense(t), 0);

    const catMap = new Map<string, number>();
    const incCatMap = new Map<string, number>();
    for (const t of txs) {
        if (t.kind === "income") {
            const name = t.category_name || "Pemasukan lainnya";
            incCatMap.set(name, (incCatMap.get(name) || 0) + t.amount);
        } else if (t.kind === "expense" || t.kind === "refund") {
            if (t.splits?.length) {
                for (const sp of t.splits) {
                    const cName =
                        store.categories.find(c => c.id === sp.category_id)?.name || "Belum dikategorikan";
                    catMap.set(cName, (catMap.get(cName) || 0) + sp.amount);
                }
            } else {
                const name = t.category_name || "Belum dikategorikan";
                catMap.set(name, (catMap.get(name) || 0) + expense(t));
            }
        } else if (t.kind === "transfer" && t.fee) {
            catMap.set("Biaya admin", (catMap.get("Biaya admin") || 0) + t.fee);
        }
    }

    const categories = Array.from(catMap.entries())
        .filter(([, amount]) => amount > 0)
        .map(([name, amount]) => ({ name, amount }))
        .sort((a, b) => b.amount - a.amount);

    const income_categories = Array.from(incCatMap.entries())
        .filter(([, amount]) => amount > 0)
        .map(([name, amount]) => ({ name, amount }))
        .sort((a, b) => b.amount - a.amount);

    const startMs = new Date(start + "T12:00:00").getTime();
    const endMs = new Date(end + "T12:00:00").getTime();
    const spanMs = Math.max(86400000, endMs - startMs + 86400000);
    const prevEndDate = new Date(startMs - 86400000);
    const prevStartDate = new Date(startMs - spanMs);
    const fmt = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const prevStart = fmt(prevStartDate);
    const prevEnd = fmt(prevEndDate);
    const prevTxs = store.transactions.filter(t => t.date >= prevStart && t.date <= prevEnd);
    const prevIncome = prevTxs.reduce((s, t) => s + (t.kind === "income" ? t.amount : 0), 0);
    const prevExpense = prevTxs.reduce((s, t) => s + expense(t), 0);

    const accounts = computeAccounts(store, end);
    const budgets = computeBudgets(store, start, end);

    return {
        start,
        end,
        income: inc,
        expense: ex,
        net: inc - ex,
        categories,
        income_categories,
        budgets,
        previous: {
            start: prevStart,
            end: prevEnd,
            income: prevIncome,
            expense: prevExpense,
            net: prevIncome - prevExpense,
        },
        accounts,
        reviews: 0,
        transactions: txs,
    };
}

export function demo(month: string, customSettings?: Settings): Data {
    const store = loadStore();
    if (customSettings) {
        store.settings = customSettings;
    }
    const { start, end } = period(month, store.settings.monthly_start_day || 1);
    const accounts = computeAccounts(store);
    const summary = computeSummary(store, start, end);
    return {
        accounts,
        categories: store.categories,
        transactions: summary.transactions,
        budgets: summary.budgets || [],
        settings: store.settings,
        reviews: [],
        summary,
    };
}

export function handleDemoRequest(path: string, init: RequestInit = {}): unknown {
    const store = loadStore();
    const method = (init.method || "GET").toUpperCase();
    const url = new URL(path, "http://localhost");
    const pathname = url.pathname;
    const body =
        init.body && typeof init.body === "string"
            ? JSON.parse(init.body)
            : init.body instanceof FormData
              ? init.body
              : {};

    // Settings
    if (pathname === "/settings") {
        if (method === "GET") return store.settings;
        if (method === "PUT") {
            store.settings = { ...store.settings, ...body };
            saveStore(store);
            return store.settings;
        }
    }

    // Accounts
    if (pathname === "/accounts") {
        if (method === "GET") return computeAccounts(store);
        if (method === "POST") {
            const id = "acc-" + Date.now();
            const acc: Account = {
                id,
                code: body.code || id.toUpperCase(),
                name: body.name,
                kind: body.kind || "wallet",
                opening_date: body.opening_date || today(),
                opening_balance: body.opening_balance ?? 0,
            };
            store.accounts.push(acc);
            saveStore(store);
            return computeAccounts(store).find(a => a.id === id);
        }
    }
    if (pathname.startsWith("/accounts/")) {
        const id = decodeURIComponent(pathname.slice("/accounts/".length));
        const idx = store.accounts.findIndex(a => a.id === id);
        if (idx === -1) throw new Error("Dompet tidak ditemukan.");
        if (method === "PATCH") {
            const current = store.accounts[idx];
            store.accounts[idx] = {
                ...current,
                name: body.name ?? current.name,
                code: body.code ?? current.code,
                kind: body.kind ?? current.kind,
                opening_date: body.clear_opening ? null : body.opening_date ?? current.opening_date,
                opening_balance: body.clear_opening ? null : body.opening_balance ?? current.opening_balance,
            };
            saveStore(store);
            return computeAccounts(store).find(a => a.id === id);
        }
        if (method === "DELETE") {
            const transferTo = url.searchParams.get("transfer_to");
            if (transferTo) {
                const migrated: Transaction[] = [];
                for (const t of store.transactions) {
                    if (
                        t.kind === "transfer" &&
                        ((t.account_id === id && t.to_account_id === transferTo) ||
                            (t.account_id === transferTo && t.to_account_id === id))
                    ) {
                        continue;
                    }
                    migrated.push({
                        ...t,
                        account_id: t.account_id === id ? transferTo : t.account_id,
                        to_account_id: t.to_account_id === id ? transferTo : t.to_account_id,
                    });
                }
                store.transactions = migrated;
            } else {
                store.transactions = store.transactions.filter(
                    t => t.account_id !== id && t.to_account_id !== id
                );
            }
            store.accounts.splice(idx, 1);
            if (store.settings.default_account_id === id) {
                store.settings.default_account_id = transferTo || store.accounts[0]?.id || null;
            }
            saveStore(store);
            return null;
        }
    }

    // Categories
    if (pathname === "/categories") {
        if (method === "GET") return store.categories;
        if (method === "POST") {
            const id = "cat-" + Date.now();
            const cat: Category = {
                id,
                code: body.code || id.toUpperCase(),
                name: body.name,
                kind: body.kind || "expense",
                parent_id: body.parent_id || null,
                archived: false,
            };
            store.categories.push(cat);
            saveStore(store);
            return cat;
        }
    }
    if (pathname.startsWith("/categories/")) {
        const id = decodeURIComponent(pathname.slice("/categories/".length));
        const idx = store.categories.findIndex(c => c.id === id);
        if (idx === -1) throw new Error("Kategori tidak ditemukan.");
        if (method === "PATCH") {
            store.categories[idx] = { ...store.categories[idx], ...body };
            saveStore(store);
            return store.categories[idx];
        }
        if (method === "DELETE") {
            const transferTo = url.searchParams.get("transfer_to") || null;
            store.transactions = store.transactions.map(t => ({
                ...t,
                category_id: t.category_id === id ? transferTo : t.category_id,
            }));
            store.categories = store.categories
                .filter(c => c.id !== id)
                .map(c => ({ ...c, parent_id: c.parent_id === id ? transferTo : c.parent_id }));
            store.budgetSpecs = store.budgetSpecs.filter(b => b.category_id !== id);
            saveStore(store);
            return null;
        }
    }

    // Transactions
    if (pathname === "/transactions") {
        if (method === "GET") {
            const start = url.searchParams.get("start") || "0000-01-01";
            const end = url.searchParams.get("end") || "9999-12-31";
            return store.transactions
                .filter(t => t.date >= start && t.date <= end)
                .sort((a, b) => b.date.localeCompare(a.date))
                .map(t => decorateTx(t, store));
        }
        if (method === "POST") {
            const id = "tx-" + Date.now();
            const tx: Transaction = {
                id,
                date: body.date || today(),
                kind: body.kind || "expense",
                account_id: body.account_id,
                to_account_id: body.to_account_id || null,
                amount: Number(body.amount),
                fee: Number(body.fee || 0),
                description: body.description || "",
                category_id: body.category_id || null,
                original_id: body.original_id || null,
                splits: body.splits || undefined,
                source: "manual",
            };
            store.transactions.unshift(tx);
            saveStore(store);
            return decorateTx(tx, store);
        }
    }
    if (pathname.startsWith("/transactions/")) {
        const id = decodeURIComponent(pathname.slice("/transactions/".length));
        const idx = store.transactions.findIndex(t => t.id === id);
        if (idx === -1) throw new Error("Transaksi tidak ditemukan.");
        if (method === "PUT" || method === "PATCH") {
            store.transactions[idx] = {
                ...store.transactions[idx],
                date: body.date,
                kind: body.kind,
                account_id: body.account_id,
                to_account_id: body.to_account_id || null,
                amount: Number(body.amount),
                fee: Number(body.fee || 0),
                description: body.description || "",
                category_id: body.category_id || null,
                original_id: body.original_id || null,
                splits: body.splits || undefined,
            };
            saveStore(store);
            return decorateTx(store.transactions[idx], store);
        }
        if (method === "DELETE") {
            store.transactions.splice(idx, 1);
            saveStore(store);
            return null;
        }
    }

    // Budgets
    if (pathname === "/budgets") {
        if (method === "GET") {
            const start = url.searchParams.get("start") || today().slice(0, 7) + "-01";
            const end = url.searchParams.get("end") || today();
            return computeBudgets(store, start, end);
        }
        if (method === "POST") {
            const existing = store.budgetSpecs.find(b => b.category_id === body.category_id);
            if (existing) {
                existing.amount = Number(body.amount);
            } else {
                store.budgetSpecs.push({
                    id: "b-" + Date.now(),
                    category_id: body.category_id,
                    amount: Number(body.amount),
                });
            }
            saveStore(store);
            return { category_id: body.category_id, amount: Number(body.amount) };
        }
    }
    if (pathname.startsWith("/budgets/")) {
        const id = decodeURIComponent(pathname.slice("/budgets/".length));
        if (method === "DELETE") {
            store.budgetSpecs = store.budgetSpecs.filter(b => b.id !== id && b.category_id !== id);
            saveStore(store);
            return null;
        }
    }

    // Summary
    if (pathname === "/summary") {
        const start = url.searchParams.get("start") || today().slice(0, 7) + "-01";
        const end = url.searchParams.get("end") || today();
        return computeSummary(store, start, end);
    }

    // Receipt Auto-Scan in Demo Mode
    if (pathname === "/receipts/scan" && method === "POST") {
        let filename = "Struk Belanja";
        if (body instanceof FormData) {
            const f = body.get("file");
            if (f && typeof (f as File).name === "string") {
                filename = (f as File).name;
            }
        }
        const clean = filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
        const numMatch = clean.match(/(\d{2,9})/);
        const amount = numMatch ? Number(numMatch[1]) : 45000;
        const merchant =
            clean && !/^(img|dsc|image|photo|struk|whatsapp)/i.test(clean)
                ? clean
                : "Kopi Kenangan & Bakery";
        const catId = inferCategoryClient(merchant, store.categories, store.transactions);
        const cat = store.categories.find(c => c.id === catId);
        return {
            merchant,
            amount,
            amount_options: [amount, amount + 5000],
            date: today(),
            category_id: cat?.id || "food",
            category_name: cat?.name || "Makan & minum",
        };
    }

    if (pathname === "/reviews") return [];
    if (pathname === "/connections")
        return [
            { source: "bca", last_received_at: null },
            { source: "gopay", last_received_at: null },
            { source: "telegram", last_received_at: null },
        ];

    return null;
}
