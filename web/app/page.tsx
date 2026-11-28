"use client";
import { useCallback, useEffect, useState } from "react";
import { BottomNav, PageHeader, QuickFab, SidebarNav, Topbar } from "../components/layout/AppChrome";
import { AppDialogs, type Dialog, type EntryPreset } from "../components/layout/AppDialogs";
import { PageContent } from "../components/layout/PageContent";
import type { Page } from "../components/layout/navigation";
import { ErrorNote, Modal } from "../components/ui";
import type { TxViewMode } from "../features/transactions/TransactionsView";
import { useAuth } from "../hooks/useAuth";
import { useLedgerData } from "../hooks/useLedgerData";
import { type RealtimeSyncEvent, useRealtimeSync } from "../hooks/useRealtimeSync";
import { useTheme } from "../hooks/useTheme";
import type { Account, Category, Review, Transaction } from "../lib/domain";

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
                        <PageContent
                            page={page}
                            data={data}
                            month={month}
                            demoMode={demoMode}
                            theme={theme}
                            txView={txView}
                            setTxView={setTxView}
                            recentIds={recentIds}
                            filter={filter}
                            setFilter={setFilter}
                            accountFilter={accountFilter}
                            setAccountFilter={setAccountFilter}
                            search={search}
                            setSearch={setSearch}
                            onNav={nav}
                            onOpenDialog={openDialog}
                            onOpenEntry={openEntry}
                            onPickMonth={pickMonth}
                            onRefresh={refresh}
                            onShowToast={showToast}
                            onError={setError}
                            onToggleTheme={applyTheme}
                            onSelectTx={setSelectedTx}
                            onSelectReview={setSelectedReview}
                            onSelectAccount={setSelectedAccount}
                            onSelectCategory={setSelectedCategory}
                        />
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

            <AppDialogs
                dialog={dialog}
                entryPreset={entryPreset}
                authed={authed}
                data={data}
                selectedTx={selectedTx}
                selectedAccount={selectedAccount}
                selectedCategory={selectedCategory}
                selectedReview={selectedReview}
                onClose={() => setDialog(null)}
                onOpenDialog={openDialog}
                onFinishMutation={finishMutation}
                onRefresh={refresh}
                onConnected={() => {
                    markConnected();
                    setDialog(null);
                    refresh();
                }}
                onLogout={handleLogout}
                onError={setError}
            />
        </div>
    );
}
