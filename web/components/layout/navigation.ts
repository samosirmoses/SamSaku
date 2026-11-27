import {
    BarChart3,
    Database,
    FileChartColumnIncreasing,
    FileSpreadsheet,
    Home,
    Inbox,
    ReceiptText,
    Settings as SettingsIcon,
    Wallet,
} from "lucide-react";

export type Page =
    | "home"
    | "transactions"
    | "budgets"
    | "stats"
    | "reviews"
    | "reports"
    | "import"
    | "masters"
    | "settings";

export const PAGE_LABELS: Record<Page, string> = {
    home: "Ringkasan",
    transactions: "Transaksi",
    budgets: "Anggaran",
    stats: "Statistik",
    reviews: "Tinjauan",
    reports: "Laporan",
    import: "Impor Excel",
    masters: "Master data",
    settings: "Pengaturan",
};

export const NAV_LINKS = [
    { page: "home", icon: Home },
    { page: "transactions", icon: ReceiptText },
    { page: "budgets", icon: Wallet },
    { page: "stats", icon: BarChart3 },
    { page: "reviews", icon: Inbox },
    { page: "reports", icon: FileChartColumnIncreasing },
    { page: "import", icon: FileSpreadsheet },
    { page: "masters", icon: Database },
    { page: "settings", icon: SettingsIcon },
] as const;
