"use client";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import { BottomNav, PageHeader, QuickFab, SidebarNav, Topbar } from "../components/layout/AppChrome";
import type { Page } from "../components/layout/navigation";
import { ErrorNote, Modal } from "../components/ui";
import { DashboardView } from "../features/dashboard/DashboardView";
import { useAuth } from "../hooks/useAuth";
import { useLedgerData } from "../hooks/useLedgerData";
import { useRealtimeSync } from "../hooks/useRealtimeSync";
import { useTheme } from "../hooks/useTheme";
import {
    type Account,
    type Category,
    type Review,
    type Transaction,
    cycleMonthForDate,
    today,
} from "../lib/domain";

const LoadingCard = () => (
    <div role="status" className="card loading">
        Memuat tampilan…
    </div>
);

// Lazy-load secondary pages & modals to keep initial bundle small on mobile and low-bandwidth connections
const TransactionsView = dynamic(
    () => import("../features/transactions/TransactionsView").then(m => m.TransactionsView),
    { loading: LoadingCard }
);
const BudgetsView = dynamic(() => import("../features/budgets/BudgetsView").then(m => m.BudgetsView), {
    loading: LoadingCard,
});
const StatisticsView = dynamic(() => import("../features/statistics/StatisticsView").then(m => m.StatisticsView), {
    loading: LoadingCard,
});
const ReportsView = dynamic(() => import("../features/reports/ReportsView").then(m => m.ReportsView), {
    loading: LoadingCard,
});
const ImporterView = dynamic(() => import("../features/importer/ImporterView").then(m => m.ImporterView), {
    loading: LoadingCard,
});
const MastersView = dynamic(() => import("../features/masters/MastersView").then(m => m.MastersView), {
    loading: LoadingCard,
});
const SettingsView = dynamic(() => import("../features/settings/SettingsView").then(m => m.SettingsView), {
    loading: LoadingCard,
});
const ReviewsView = dynamic(() => import("../features/reviews/ReviewsView").then(m => m.ReviewsView), {
    loading: LoadingCard,
});
const LoginModal = dynamic(() => import("../features/auth/LoginModal").then(m => m.LoginModal));
const EntryForm = dynamic(() => import("../features/transactions/EntryForm").then(m => m.EntryForm));
const TransactionDetailModal = dynamic(
    () => import("../features/transactions/TransactionDetailModal").then(m => m.TransactionDetailModal)
);
const MasterForm = dynamic(() => import("../features/masters/MasterForm").then(m => m.MasterForm));
const CategoryEdit = dynamic(() => import("../features/masters/CategoryEdit").then(m => m.CategoryEdit));
const ReviewModal = dynamic(() => import("../features/reviews/ReviewModal").then(m => m.ReviewModal));

type Dialog =
    | "login"
    | "entry"
    | "edit-entry"
    | "account"
    | "edit-account"
    | "category"
    | "edit-category"
    | "detail"
    | "review"
    | "receipt"
    | null;

type EntryPreset = {
    date?: string;
    kind?: Transaction["kind"];
    account_id?: string;
    autoScan?: boolean;
};

export default function SamSakuApp() {
    const { theme, applyTheme } = useTheme();
    const { authed, demoMode, ready, markConnected, logout } = useAuth();
    const { month, pickMonth, data, loading, error, setError, refresh, lastFetchedAt } = useLedgerData({
        ready,
        demoMode,
    });

    const [page, setPage] = useState<Page>("home");
    const [menuOpen, setMenuOpen] = useState(false);
    const [fabOpen, setFabOpen] = useState(false);
    const [dialog, setDialog] = useState<Dialog>(null);
    const [notice, setNotice] = useState("");

    const [filter, setFilter] = useState("");
    const [accountFilter, setAccountFilter] = useState("");
    const [search, setSearch] = useState("");

    const [selectedTx, setSelectedTx] = useState<Transaction | null>(null);
    const [selectedReview, setSelectedReview] = useState<Review | null>(null);
    const [selectedCategory, setSelectedCategory] = useState<Category | null>(null);
    const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);
    const [entryPreset, setEntryPreset] = useState<EntryPreset>({});

    const handleRealtimeSync = useCallback(
        (msg?: string) => {
            refresh(true);
            if (msg) setNotice(msg);
        },
        [refresh]
    );

    const { live } = useRealtimeSync({ ready, authed, demoMode, lastFetchedAt, onSync: handleRealtimeSync });

    useEffect(() => {
        if (!notice) return;
        const timer = setTimeout(() => setNotice(""), 4000);
        return () => clearTimeout(timer);
    }, [notice]);

    function nav(nextPage: Page) {
        setPage(nextPage);
        setMenuOpen(false);
        setFabOpen(false);
        setFilter("");
        setAccountFilter("");
        setSearch("");
        window.scrollTo({ top: 0 });
    }

    function openDialog(nextDialog: Dialog) {
        setFabOpen(false);
        setDialog(nextDialog);
    }

    function openEntry(opts: EntryPreset = {}) {
        setFabOpen(false);
        setEntryPreset(opts);
        setDialog(opts.autoScan ? "receipt" : "entry");
    }

    function finishMutation(message = "Perubahan tersimpan.") {
        setDialog(null);
        setSelectedTx(null);
        setSelectedAccount(null);
        setSelectedCategory(null);
        setSelectedReview(null);
        refresh();
        setNotice(message);
    }

    async function handleLogout() {
        const errMsg = await logout();
        if (errMsg) {
            setNotice(errMsg);
            return;
        }
        setSelectedTx(null);
        setSelectedReview(null);
        setFilter("");
        setAccountFilter("");
        setSearch("");
        setDialog(null);
        refresh();
    }

    const dialogTitles: Record<Exclude<Dialog, null>, string> = {
        login: "Koneksi Server & Akun",
        entry:
            entryPreset.kind === "transfer"
                ? "Transfer Antar Dompet"
                : entryPreset.kind === "income"
                  ? "Catat Pemasukan"
                  : "Catat Transaksi",
        "edit-entry": "Ubah Transaksi",
        account: "Tambah Dompet Baru",
        "edit-account": "Ubah / Hapus Dompet",
        category: "Buat Kategori Baru",
        "edit-category": "Ubah / Hapus Kategori",
        detail: "Detail Transaksi",
        review: "Tinjau Bukti",
        receipt: "Foto Struk (Auto-Fill)",
    };

    const startDay = data?.settings?.monthly_start_day || 1;

    return (
        <div className="app-shell">
            <aside className="sidebar">
                <SidebarNav
                    page={page}
                    authed={authed}
                    onNav={nav}
                    onAuthAction={() => (authed ? handleLogout() : setDialog("login"))}
                />
            </aside>

            {menuOpen && (
                <Modal title="Navigasi SamSaku" onClose={() => setMenuOpen(false)}>
                    <div className="mobile-side">
                        <SidebarNav
                            page={page}
                            authed={authed}
                            onNav={nav}
                            onAuthAction={() => {
                                setMenuOpen(false);
                                if (authed) handleLogout();
                                else setDialog("login");
                            }}
                        />
                    </div>
                </Modal>
            )}

            <main className="workspace">
                <Topbar
                    page={page}
                    theme={theme}
                    ready={ready}
                    demoMode={demoMode}
                    live={live}
                    onOpenMenu={() => setMenuOpen(true)}
                    onToggleTheme={applyTheme}
                    onOpenSettings={() => nav("settings")}
                    onOpenLogin={() => setDialog("login")}
                />

                <div className="page-body">
                    <PageHeader
                        page={page}
                        month={month}
                        startDay={startDay}
                        onPickMonth={m => pickMonth(m, true)}
                        onOpenStats={() => nav("stats")}
                        onNewEntry={() => openEntry()}
                    />

                    {error && (
                        <div className="card">
                            <ErrorNote message={error} />
                            <div className="btns">
                                <button className="btn" onClick={() => refresh()}>
                                    Coba lagi
                                </button>
                                <button className="btn" onClick={() => setDialog("login")}>
                                    Pengaturan koneksi
                                </button>
                            </div>
                        </div>
                    )}

                    {(!ready || loading) && (
                        <div role="status" className="card loading">
                            Memuat data keuangan…
                        </div>
                    )}

                    {data && (
                        <>
                            {page === "home" && (
                                <DashboardView
                                    data={data}
                                    month={month}
                                    onCategory={name => {
                                        nav("transactions");
                                        setFilter(name);
                                    }}
                                    onTx={t => {
                                        setSelectedTx(t);
                                        openDialog("detail");
                                    }}
                                    onAccounts={() => nav("masters")}
                                    onEditAccount={a => {
                                        setSelectedAccount(a);
                                        openDialog("edit-account");
                                    }}
                                    onAddAccount={() => {
                                        setSelectedAccount(null);
                                        openDialog("account");
                                    }}
                                    onFilterAccount={accId => {
                                        nav("transactions");
                                        setAccountFilter(accId);
                                    }}
                                    onNewTx={() => openEntry({ kind: "expense" })}
                                    onScanReceipt={() => openEntry({ kind: "expense", autoScan: true })}
                                    onTransfer={fromAccId => openEntry({ kind: "transfer", account_id: fromAccId })}
                                    onBudgets={() => nav("budgets")}
                                    onStats={() => nav("stats")}
                                    onAll={() => nav("transactions")}
                                    onReview={() => nav("reviews")}
                                />
                            )}

                            {page === "transactions" && (
                                <TransactionsView
                                    data={data}
                                    month={month}
                                    filter={filter}
                                    setFilter={setFilter}
                                    accountFilter={accountFilter}
                                    setAccountFilter={setAccountFilter}
                                    search={search}
                                    setSearch={setSearch}
                                    onOpenTx={t => {
                                        setSelectedTx(t);
                                        openDialog("detail");
                                    }}
                                    onAddAtDate={(date, kind) => openEntry({ date, kind: kind || "expense" })}
                                    onScanAtDate={date => openEntry({ date, kind: "expense", autoScan: true })}
                                    onTransferAtDate={date => openEntry({ date, kind: "transfer" })}
                                />
                            )}

                            {page === "budgets" && (
                                <BudgetsView
                                    data={data}
                                    month={month}
                                    onSelectCategory={catName => {
                                        nav("transactions");
                                        setFilter(catName);
                                    }}
                                    onDone={() => {
                                        refresh();
                                        setNotice("Anggaran diperbarui.");
                                    }}
                                />
                            )}

                            {page === "stats" && (
                                <StatisticsView
                                    data={data}
                                    month={month}
                                    onSelectCategory={catName => {
                                        nav("transactions");
                                        setFilter(catName);
                                    }}
                                />
                            )}

                            {page === "reports" && (
                                <ReportsView
                                    data={data}
                                    month={month}
                                    demoMode={demoMode}
                                    setMonth={m => pickMonth(m, true)}
                                />
                            )}

                            {page === "import" && (
                                <ImporterView
                                    data={data}
                                    demoMode={demoMode}
                                    onLogin={() => setDialog("login")}
                                    onDone={() => refresh()}
                                />
                            )}

                            {page === "masters" && (
                                <MastersView
                                    data={data}
                                    onEditAccount={a => {
                                        setSelectedAccount(a);
                                        openDialog("edit-account");
                                    }}
                                    onAddAccount={() => {
                                        setSelectedAccount(null);
                                        openDialog("account");
                                    }}
                                    onTransfer={fromAccId => openEntry({ kind: "transfer", account_id: fromAccId })}
                                    onFilterAccount={accId => {
                                        nav("transactions");
                                        setAccountFilter(accId);
                                    }}
                                    onAddCategory={() => openDialog("category")}
                                    onEditCategory={c => {
                                        setSelectedCategory(c);
                                        openDialog("edit-category");
                                    }}
                                    onOpenImport={() => nav("import")}
                                />
                            )}

                            {page === "settings" && (
                                <SettingsView
                                    data={data}
                                    month={month}
                                    demoMode={demoMode}
                                    theme={theme}
                                    onToggleTheme={applyTheme}
                                    onDone={nextStartDay => {
                                        if (typeof nextStartDay === "number") {
                                            pickMonth(cycleMonthForDate(today(), nextStartDay), false);
                                        }
                                        refresh();
                                        setNotice("Pengaturan disimpan.");
                                    }}
                                />
                            )}

                            {page === "reviews" && (
                                <ReviewsView
                                    reviews={data.reviews}
                                    onSelect={r => {
                                        setSelectedReview(r);
                                        openDialog("review");
                                    }}
                                />
                            )}
                        </>
                    )}
                </div>
            </main>

            {data && (
                <QuickFab
                    open={fabOpen}
                    canTransfer={data.accounts.length >= 2}
                    onToggle={() => setFabOpen(v => !v)}
                    onOpenEntry={opts => openEntry(opts)}
                />
            )}

            <BottomNav page={page} onNav={nav} onOpenMenu={() => setMenuOpen(true)} />

            {notice && (
                <div className="toast" role="status">
                    {notice}
                </div>
            )}

            {dialog && (
                <Modal
                    title={dialogTitles[dialog]}
                    onClose={() => setDialog(null)}
                    wide={["entry", "edit-entry", "receipt", "account", "edit-account"].includes(dialog)}
                    key={dialog}
                >
                    {dialog === "login" && (
                        <LoginModal
                            authed={authed}
                            onLogout={handleLogout}
                            onConnected={() => {
                                markConnected();
                                setDialog(null);
                                refresh();
                            }}
                        />
                    )}

                    {data && (
                        <>
                            {dialog === "entry" && (
                                <EntryForm
                                    data={data}
                                    initial={{
                                        date: entryPreset.date,
                                        kind: entryPreset.kind,
                                        account_id: entryPreset.account_id,
                                    }}
                                    autoScan={entryPreset.autoScan}
                                    onDone={() => finishMutation()}
                                />
                            )}

                            {dialog === "edit-entry" && selectedTx && (
                                <EntryForm data={data} tx={selectedTx} onDone={() => finishMutation()} />
                            )}

                            {dialog === "account" && (
                                <MasterForm mode="account" data={data} onDone={() => finishMutation()} />
                            )}

                            {dialog === "edit-account" && selectedAccount && (
                                <MasterForm
                                    mode="account"
                                    data={data}
                                    account={selectedAccount}
                                    onDone={() => finishMutation()}
                                />
                            )}

                            {dialog === "category" && (
                                <MasterForm mode="category" data={data} onDone={() => finishMutation()} />
                            )}

                            {dialog === "detail" && selectedTx && (
                                <TransactionDetailModal
                                    doc={selectedTx}
                                    data={data}
                                    onEdit={() => openDialog("edit-entry")}
                                    onDeleted={() => finishMutation("Transaksi dihapus.")}
                                    onError={msg => setError(msg)}
                                />
                            )}

                            {dialog === "edit-category" && selectedCategory && (
                                <CategoryEdit
                                    category={selectedCategory}
                                    categories={data.categories}
                                    done={() => finishMutation()}
                                />
                            )}

                            {dialog === "receipt" && (
                                <EntryForm
                                    data={data}
                                    initial={{ date: entryPreset.date, kind: "expense" }}
                                    autoScan={true}
                                    onDone={() => finishMutation()}
                                />
                            )}

                            {dialog === "review" && selectedReview && (
                                <ReviewModal r={selectedReview} data={data} done={() => finishMutation()} />
                            )}
                        </>
                    )}
                </Modal>
            )}
        </div>
    );
}
