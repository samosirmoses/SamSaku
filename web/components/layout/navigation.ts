import {
    BarChart3,
    Database,
    FileChartColumnIncreasing,
    FileSpreadsheet,
    Home,
    ReceiptText,
    Settings as SettingsIcon,
    Wallet,
} from "lucide-react";

export type Page =
    | "home"
    | "transactions"
    | "budgets"
    | "stats"
    | "reports"
    | "import"
    | "masters"
    | "settings"
    | "reviews";

export const PAGE_LABELS: Record<Page, string> = {
    home: "Ringkasan",
    transactions: "Transaksi",
    budgets: "Anggaran",
    stats: "Statistik",
    reports: "Laporan",
    import: "Impor Excel",
    masters: "Master data",
    settings: "Pengaturan",
    reviews: "Perlu ditinjau",
};

export const NAV_LINKS = [
    { page: "home", icon: Home },
    { page: "transactions", icon: ReceiptText },
    { page: "budgets", icon: Wallet },
    { page: "stats", icon: BarChart3 },
    { page: "reports", icon: FileChartColumnIncreasing },
    { page: "import", icon: FileSpreadsheet },
    { page: "masters", icon: Database },
    { page: "settings", icon: SettingsIcon },
] as const;
