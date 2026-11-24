export type Account = {
    id: string;
    code: string;
    name: string;
    opening_date?: string | null;
    opening_balance?: number | null;
    balance?: number | null;
    reserved?: number;
    free_balance?: number | null;
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
    category_name?: string;
    original_id?: string | null;
    source?: string;
    splits?: {
        category_id: string | null;
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
    };
    occurred_at?: string;
};
export type Rule = {
    name: string;
    mode: "fixed" | "percent" | "remainder";
    value: number;
    category_ids: string[];
    goal_id?: string;
    rollover?: boolean;
};
export type Scheme = {
    id: string;
    name: string;
    cycle_day: number;
    pots?: {
        name: string;
        allocated: number;
        used: number;
        remaining: number;
    }[];
    rules: Rule[];
};
export type Goal = {
    id: string;
    name: string;
    target: number;
    reserved?: number;
};
export type Summary = {
    income: number;
    expense: number;
    net: number;
    categories: {
        name: string;
        amount: number;
    }[];
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
    schemes: Scheme[];
    goals: Goal[];
    summary: Summary;
    connections?: {
        source: string;
        last_received_at: string | null;
    }[];
};
export const money = (v: number) => new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(v).replace(/\s/g, "");
export const shortDate = (d: string) => new Date(d.slice(0, 10) + "T12:00:00").toLocaleDateString("id-ID", { day: "numeric", month: "short" });
export const monthLabel = (m: string) => new Date(m + "-01T12:00:00").toLocaleDateString("id-ID", { month: "long", year: "numeric" });
export function today() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
export function period(month: string) { const [y, m] = month.split("-").map(Number); const last = String(new Date(y, m, 0).getDate()).padStart(2, "0"); return { start: month + "-01", end: month === today().slice(0, 7) ? today() : month + "-" + last }; }
export function categoryMatches(t: Transaction, name: string, categories: Category[]) {
    if (!name)
        return true;
    if (t.splits?.length)
        return t.splits.some(s => (s.role === "fee" ? "Biaya admin" : categories.find(c => c.id === s.category_id)?.name || "Belum dikategorikan") === name);
    return (t.category_name || categories.find(c => c.id === t.category_id)?.name || "Belum dikategorikan") === name;
}
export const kindLabels = { income: "Pemasukan", expense: "Pengeluaran", transfer: "Transfer", refund: "Refund" };
export function expense(t: Transaction) { return t.kind === "expense" ? t.amount : t.kind === "refund" ? -t.amount : t.kind === "transfer" ? (t.fee || 0) : 0; }
