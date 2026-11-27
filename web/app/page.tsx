"use client";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import { BottomNav, PageHeader, QuickFab, SidebarNav, Topbar } from "../components/layout/AppChrome";
import type { Page } from "../components/layout/navigation";
import { ErrorNote, Modal } from "../components/ui";
import { DashboardView } from "../features/dashboard/DashboardView";
import type { TxViewMode } from "../features/transactions/TransactionsView";
import { useAuth } from "../hooks/useAuth";
import { useLedgerData } from "../hooks/useLedgerData";
import { type RealtimeSyncEvent, useRealtimeSync } from "../hooks/useRealtimeSync";
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

type ToastState = {
    text: string;
    actionLabel?: string;
    onAction?: () => void;
} | null;

export default function SamSakuApp() {
    const { theme, applyTheme } = useTheme();
    const { authed, demoMode, ready, markConnected, logout } = useAuth();
    const { month, pickMonth, data, loading, refreshing, recentIds, error, setError, refresh, lastFetchedAt } =
        useLedgerData({
            ready,
            demoMode,
        });

    const [page, setPage] = useState<Page>("home");
    const [txView, setTxViewState] = useState<TxViewMode>("daily");
    const [menuOpen, setMenuOpen] = useState(false);
    const [fabOpen, setFabOpen] = useState(false);
    const [dialog, setDialog] = useState<Dialog>(null);
    const [toast, setToast] = useState<ToastState>(null);

    const [filter, setFilter] = useState("");
    const [accountFilter, setAccountFilter] = useState("");
    const [search, setSearch] = useState("");

    const [selectedTx, setSelectedTx] = useState<Transaction | null>(null);
    const [selectedReview, setSelectedReview] = useState<Review | null>(null);
    const [selectedCategory, setSelectedCategory] = useState<Category | null>(null);
    const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);
    const [entryPreset, setEntryPreset] = useState<EntryPreset>({});

    useEffect(() => {
        try {
            const saved = sessionStorage.getItem("samsaku-tx-view");
            if (saved === "daily" || saved === "calendar" || saved === "monthly") {
                setTxViewState(saved);
            }
        } catch {}
    }, []);

    const setTxView = useCallback((next: TxViewMode) => {
        setTxViewState(next);
        try {
            sessionStorage.setItem("samsaku-tx-view", next);
        } catch {}
    }, []);

    const showToast = useCallback((text: string, actionLabel?: string, onAction?: () => void) => {
        setToast(text ? { text, actionLabel, onAction } : null);
    }, []);

    const handleRealtimeSync = useCallback(
        (info?: RealtimeSyncEvent) => {
            refresh(true);
            const msg = info?.message;
            const ev = info?.event || "";
            if (msg) {
                if (ev === "telegram:new" || ev.startsWith("event:")) {
                    showToast(msg, "Tinjau →", () => {
                        setPage("reviews");
                        setToast(null);
                    });
                } else {
                    showToast(msg);
                }
            }
        },
        [refresh, showToast]
    );

    const { live } = useRealtimeSync({ ready, authed, demoMode, lastFetchedAt, onSync: handleRealtimeSync });

    useEffect(() => {
        if (!toast) return;
        const timer = setTimeout(() => setToast(null), 5000);
        return () => clearTimeout(timer);
    }, [toast]);

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
        refresh(true);
        showToast(message);
    }

    async function handleLogout() {
        const errMsg = await logout();
        if (errMsg) {
            showToast(errMsg);
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
    const reviewCount = data?.reviews?.length || 0;

    return (
        <div className="app-shell">
            <aside className="sidebar">
                <SidebarNav
                    page={page}
                    authed={authed}
                    reviewCount={reviewCount}
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
                            reviewCount={reviewCount}
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
                    refreshing={refreshing}
                    reviewCount={reviewCount}
                    onOpenMenu={() => setMenuOpen(true)}
                    onToggleTheme={applyTheme}
                    onOpenSettings={() => nav("settings")}
                    onOpenReviews={() => nav("reviews")}
                    onOpenLogin={() => setDialog("login")}
                />

                <div className="page-body">
                    <PageHeader
                        page={page}
                        month={month}
                        startDay={startDay}
                        onPickMonth={m => pickMonth(m, true)}
                        onScanReceipt={() => openEntry({ kind: "expense", autoScan: true })}
                        onNewEntry={() => openEntry()}
                    />

                    {error && (
                        <div className="card" style={{ marginBottom: 18 }}>
                            <ErrorNote message={error} />
                            <div className="btns" style={{ marginTop: 10 }}>
                                <button className="btn" onClick={() => refresh()}>
                                    Coba lagi
                                </button>
                                <button className="btn" onClick={() => setDialog("login")}>
                                    Pengaturan koneksi
                                </button>
                            </div>
                        </div>
                    )}

                    {(!ready || (loading && !data)) && (
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
                                    highlightIds={recentIds}
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
                                    onTransfer={fromAccId => openEntry({ kind: "transfer", account_id: fromAccId })}
                                    onBudgets={() => nav("budgets")}
                                    onStats={() => nav("stats")}
                                    onAll={() => nav("transactions")}
                                    onSelectReview={r => {
                                        setSelectedReview(r);
                                        openDialog("review");
                                    }}
                                    onReview={() => nav("reviews")}
                                    onReviewResolved={msg => {
                                        refresh(true);
                                        showToast(msg);
                                    }}
                                    onError={msg => setError(msg)}
                                />
                            )}

                            {page === "transactions" && (
                                <TransactionsView
                                    data={data}
                                    month={month}
                                    view={txView}
                                    setView={setTxView}
                                    highlightIds={recentIds}
                                    onPickMonth={m => pickMonth(m, true)}
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
                                    onSelectReview={r => {
                                        setSelectedReview(r);
                                        openDialog("review");
                                    }}
                                    onOpenAllReviews={() => nav("reviews")}
                                    onReviewResolved={msg => {
                                        refresh(true);
                                        showToast(msg);
                                    }}
                                    onError={msg => setError(msg)}
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
                                        refresh(true);
                                        showToast("Anggaran diperbarui.");
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
                                    onDone={() => refresh(true)}
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
                                        refresh(true);
                                        showToast("Pengaturan disimpan.");
                                    }}
                                />
                            )}

                            {page === "reviews" && (
                                <ReviewsView
                                    data={data}
                                    reviews={data.reviews}
                                    highlightIds={recentIds}
                                    onSelect={r => {
                                        setSelectedReview(r);
                                        openDialog("review");
                                    }}
                                    onResolved={msg => {
                                        refresh(true);
                                        showToast(msg);
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

            <BottomNav
                page={page}
                reviewCount={reviewCount}
                onNav={nav}
                onNewEntry={() => openEntry()}
                onOpenMenu={() => setMenuOpen(true)}
            />

            {toast && (
                <div className="toast" role="status">
                    <span>{toast.text}</span>
                    {toast.actionLabel && toast.onAction && (
                        <button type="button" className="toast-action-btn" onClick={toast.onAction}>
                            {toast.actionLabel}
                        </button>
                    )}
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
                                    onSavedKeepOpen={() => refresh(true)}
                                    onDone={() => finishMutation("Transaksi tersimpan.")}
                                />
                            )}

                            {dialog === "edit-entry" && selectedTx && (
                                <EntryForm
                                    data={data}
                                    tx={selectedTx}
                                    onDone={() => finishMutation("Perubahan transaksi disimpan.")}
                                />
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
                                    onSavedKeepOpen={() => refresh(true)}
                                    onDone={() => finishMutation("Transaksi tersimpan.")}
                                />
                            )}

                            {dialog === "review" && selectedReview && (
                                <ReviewModal
                                    r={selectedReview}
                                    data={data}
                                    done={() => finishMutation("Bukti berhasil diproses.")}
                                />
                            )}
                        </>
                    )}
                </Modal>
            )}
        </div>
    );
}
