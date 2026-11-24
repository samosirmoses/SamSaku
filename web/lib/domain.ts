export type Account = {
    id: string;
    code: string;
    name: string;
    kind?: string;
    opening_date?: string | null;
    opening_balance?: number | null;
    balance?: number | null;
    reserved?: number;
    free_balance?: number | null;
    tx_count?: number;
};

export type Category = {
    id: string;
    code: string;
    name: string;
    kind: "income" | "expense";
    archived?: boolean;
    parent_id?: string | null;
};

export type Transaction = {
    id: string;
    date: string;
    kind: "income" | "expense" | "transfer" | "refund";
    account_id: string;
    to_account_id?: string | null;
    amount: number;
    fee?: number;
    description: string;
    category_id?: string | null;
    account_name?: string;
    to_account_name?: string | null;
    category_name?: string | null;
    original_id?: string | null;
    source?: string;
    splits?: {
        category_id: string | null;
        category_name?: string | null;
        amount: number;
        role: string;
    }[];
};

export type Review = {
    id: string;
    source: string;
    text: string;
    status: string;
    parsed?: {
        kind?: Transaction["kind"];
        account_id?: string;
        date?: string;
        description?: string;
        merchant?: string;
        amount?: number;
        category_id?: string;
    };
    occurred_at?: string;
};

export type Budget = {
    id: string;
    category_id: string;
    category_name: string;
    amount: number;
    spent: number;
    remaining: number;
    percent: number;
    status: "safe" | "warning" | "over";
};

export type Settings = {
    monthly_start_day: number;
    weekly_start_day: number;
    default_account_id?: string | null;
};

export type Summary = {
    start?: string;
    end?: string;
    income: number;
    expense: number;
    net: number;
    categories: {
        name: string;
        amount: number;
    }[];
    income_categories?: {
        name: string;
        amount: number;
    }[];
    budgets?: Budget[];
    previous?: {
        start: string;
        end: string;
        income: number;
        expense: number;
        net: number;
    } | null;
    accounts: Account[];
    reviews: number;
    partial_history?: boolean;
    transactions: Transaction[];
};

export type Data = {
    accounts: Account[];
    categories: Category[];
    transactions: Transaction[];
    reviews: Review[];
    budgets: Budget[];
    settings: Settings;
    summary: Summary;
    connections?: {
        source: string;
        last_received_at: string | null;
    }[];
};

export const money = (v: number) =>
    new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 })
        .format(v)
        .replace(/\s/g, "");

export const compactMoney = (v: number) => {
    const abs = Math.abs(v);
    const sign = v < 0 ? "−" : "";
    if (abs >= 1_000_000_000) return sign + "Rp" + (abs / 1_000_000_000).toFixed(1).replace(/\.0$/, "") + "M";
    if (abs >= 1_000_000) return sign + "Rp" + (abs / 1_000_000).toFixed(1).replace(/\.0$/, "") + "jt";
    if (abs >= 1_000) return sign + "Rp" + Math.round(abs / 1_000) + "rb";
    return money(v);
};

export const shortDate = (d: string) =>
    new Date(d.slice(0, 10) + "T12:00:00").toLocaleDateString("id-ID", { day: "numeric", month: "short" });

export const fullDate = (d: string) =>
    new Date(d.slice(0, 10) + "T12:00:00").toLocaleDateString("id-ID", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
    });

export const monthLabel = (m: string) =>
    new Date(m + "-01T12:00:00").toLocaleDateString("id-ID", { month: "long", year: "numeric" });

export function today() {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Jakarta",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(new Date());
}

function daysInMonth(year: number, month1Based: number): number {
    return new Date(year, month1Based, 0).getDate();
}

function fmtIso(y: number, m: number, d: number): string {
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function period(month: string, startDay = 1): { start: string; end: string } {
    const [y, m] = month.split("-").map(Number);
    const clampedStart = Math.max(1, Math.min(31, startDay || 1));
    if (clampedStart === 1) {
        const last = daysInMonth(y, m);
        return { start: fmtIso(y, m, 1), end: fmtIso(y, m, last) };
    }
    const actualStartDay = Math.min(clampedStart, daysInMonth(y, m));
    const start = fmtIso(y, m, actualStartDay);
    const nextY = m === 12 ? y + 1 : y;
    const nextM = m === 12 ? 1 : m + 1;
    const nextCycleStartDay = Math.min(clampedStart, daysInMonth(nextY, nextM));
    const nextStartDate = new Date(nextY, nextM - 1, nextCycleStartDay, 12, 0, 0);
    nextStartDate.setDate(nextStartDate.getDate() - 1);
    const end = fmtIso(nextStartDate.getFullYear(), nextStartDate.getMonth() + 1, nextStartDate.getDate());
    return { start, end };
}

export function periodRangeLabel(month: string, startDay = 1): string {
    const { start, end } = period(month, startDay);
    const s = new Date(start + "T12:00:00");
    const e = new Date(end + "T12:00:00");
    const sameYear = s.getFullYear() === e.getFullYear();
    const sStr = s.toLocaleDateString("id-ID", {
        day: "numeric",
        month: "short",
        ...(sameYear ? {} : { year: "numeric" }),
    });
    const eStr = e.toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" });
    return `${sStr} – ${eStr}`;
}

export function shiftMonth(month: string, delta: number): string {
    const [y, m] = month.split("-").map(Number);
    const total = y * 12 + (m - 1) + delta;
    const ny = Math.floor(total / 12);
    const nm = (total % 12) + 1;
    return `${ny}-${String(nm).padStart(2, "0")}`;
}

export function categoryMatches(t: Transaction, name: string, categories: Category[]) {
    if (!name) return true;
    if (t.splits?.length)
        return t.splits.some(
            s =>
                (s.role === "fee"
                    ? "Biaya admin"
                    : categories.find(c => c.id === s.category_id)?.name || "Belum dikategorikan") === name
        );
    return (t.category_name || categories.find(c => c.id === t.category_id)?.name || "Belum dikategorikan") === name;
}

export const kindLabels: Record<Transaction["kind"], string> = {
    expense: "Pengeluaran",
    income: "Pemasukan",
    transfer: "Transfer",
    refund: "Refund",
};

export const accountKindLabels: Record<string, string> = {
    bank: "Rekening bank",
    ewallet: "Dompet digital",
    "e-wallet": "Dompet digital",
    cash: "Tunai",
    wallet: "Dompet",
};

export const weekdayNames = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
export const weekdayShort = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];

export function expense(t: Transaction) {
    return t.kind === "expense" ? t.amount : t.kind === "refund" ? -t.amount : t.kind === "transfer" ? t.fee || 0 : 0;
}

export function income(t: Transaction) {
    return t.kind === "income" ? t.amount : 0;
}

export function inferCategoryClient(text: string, categories: Category[], transactions: Transaction[]): string {
    const expenseCats = categories.filter(c => c.kind === "expense" && !c.archived);
    if (!expenseCats.length) return "";
    const hay = text.toLowerCase();

    for (const tx of transactions) {
        if (tx.kind === "expense" && tx.category_id && tx.description) {
            const d = tx.description.toLowerCase();
            if ((hay.includes(d) || d.includes(hay)) && expenseCats.some(c => c.id === tx.category_id)) {
                return tx.category_id;
            }
        }
    }

    const rules: [RegExp, RegExp][] = [
        [
            /makan|minum|kuliner|konsumsi|food|kopi|resto/,
            /kopi|coffee|cafe|resto|warung|bakso|mie|ayam|nasi|sate|soto|padang|mixue|tuku|starbucks|kfc|mcd|hokben|gofood|grabfood|makan|minum/i,
        ],
        [
            /belanja|kebutuhan|grocer|mart|rumah|pasar|shop/,
            /indomaret|alfamart|superindo|hypermart|transmart|minimarket|pasar|tokopedia|shopee|lazada|ikea|sabun|beras|minyak|belanja/i,
        ],
        [
            /transport|jalan|kendaraan|bensin|bbm|parkir|tol/,
            /pertamina|shell|spbu|pertalite|pertamax|bensin|parkir|tol|gojek|goride|gocar|grab|grabbike|grabcar|bluebird|taksi|kereta|mrt|transjakarta/i,
        ],
        [
            /tagih|utilit|listrik|air|internet|pulsa|bill/,
            /pln|listrik|token|pdam|air|indihome|biznet|wifi|internet|telkomsel|indosat|xl|pulsa|bpjs|netflix|spotify|tagihan/i,
        ],
    ];

    for (const [catRx, textRx] of rules) {
        if (textRx.test(hay)) {
            const match = expenseCats.find(c => catRx.test(c.name.toLowerCase()));
            if (match) return match.id;
        }
    }
    return expenseCats[0].id;
}
