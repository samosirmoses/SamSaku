"use client";
import dynamic from "next/dynamic";
import { DashboardView } from "../../features/dashboard/DashboardView";
import type { TxViewMode } from "../../features/transactions/TransactionsView";
import {
    type Account,
    type Category,
    type Data,
    type Review,
    type Transaction,
    cycleMonthForDate,
    today,
} from "../../lib/domain";
import type { EntryPreset } from "./AppDialogs";
import type { Dialog } from "./AppDialogs";
import type { Page } from "./navigation";

const LoadingCard = () => (
    <div role="status" className="card loading">
        Memuat tampilan…
    </div>
);

const TransactionsView = dynamic(
    () => import("../../features/transactions/TransactionsView").then(m => m.TransactionsView),
    { loading: LoadingCard }
);
const BudgetsView = dynamic(() => import("../../features/budgets/BudgetsView").then(m => m.BudgetsView), {
    loading: LoadingCard,
});
const StatisticsView = dynamic(() => import("../../features/statistics/StatisticsView").then(m => m.StatisticsView), {
    loading: LoadingCard,
});
const ReportsView = dynamic(() => import("../../features/reports/ReportsView").then(m => m.ReportsView), {
    loading: LoadingCard,
});
const ImporterView = dynamic(() => import("../../features/importer/ImporterView").then(m => m.ImporterView), {
    loading: LoadingCard,
});
const MastersView = dynamic(() => import("../../features/masters/MastersView").then(m => m.MastersView), {
    loading: LoadingCard,
});
const SettingsView = dynamic(() => import("../../features/settings/SettingsView").then(m => m.SettingsView), {
    loading: LoadingCard,
});
const ReviewsView = dynamic(() => import("../../features/reviews/ReviewsView").then(m => m.ReviewsView), {
    loading: LoadingCard,
});

export function PageContent({
    page,
    data,
    month,
    demoMode,
    theme,
    txView,
    setTxView,
    recentIds,
    filter,
    setFilter,
    accountFilter,
    setAccountFilter,
    search,
    setSearch,
    onNav,
    onOpenDialog,
    onOpenEntry,
    onPickMonth,
    onRefresh,
    onShowToast,
    onError,
    onToggleTheme,
    onSelectTx,
    onSelectReview,
    onSelectAccount,
    onSelectCategory,
}: {
    page: Page;
    data: Data;
    month: string;
    demoMode: boolean;
    theme: "light" | "dark";
    txView: TxViewMode;
    setTxView: (next: TxViewMode) => void;
    recentIds: Set<string>;
    filter: string;
    setFilter: (v: string) => void;
    accountFilter: string;
    setAccountFilter: (v: string) => void;
    search: string;
    setSearch: (v: string) => void;
    onNav: (nextPage: Page) => void;
    onOpenDialog: (d: Dialog) => void;
    onOpenEntry: (opts?: EntryPreset) => void;
    onPickMonth: (month: string, manual?: boolean) => void;
    onRefresh: (silent?: boolean) => void;
    onShowToast: (msg: string) => void;
    onError: (msg: string) => void;
    onToggleTheme: (next: "light" | "dark") => void;
    onSelectTx: (tx: Transaction | null) => void;
    onSelectReview: (r: Review | null) => void;
    onSelectAccount: (a: Account | null) => void;
    onSelectCategory: (c: Category | null) => void;
}) {
    if (page === "home") {
        return (
            <DashboardView
                data={data}
                month={month}
                highlightIds={recentIds}
                onCategory={name => {
                    onNav("transactions");
                    setFilter(name);
                }}
                onTx={t => {
                    onSelectTx(t);
                    onOpenDialog("detail");
                }}
                onAccounts={() => onNav("masters")}
                onEditAccount={a => {
                    onSelectAccount(a);
                    onOpenDialog("edit-account");
                }}
                onAddAccount={() => {
                    onSelectAccount(null);
                    onOpenDialog("account");
                }}
                onFilterAccount={accId => {
                    onNav("transactions");
                    setAccountFilter(accId);
                }}
                onNewTx={() => onOpenEntry({ kind: "expense" })}
                onTransfer={fromAccId => onOpenEntry({ kind: "transfer", account_id: fromAccId })}
                onBudgets={() => onNav("budgets")}
                onStats={() => onNav("stats")}
                onAll={() => onNav("transactions")}
                onSelectReview={r => {
                    onSelectReview(r);
                    onOpenDialog("review");
                }}
                onReview={() => onNav("reviews")}
                onReviewResolved={msg => {
                    onRefresh(true);
                    onShowToast(msg);
                }}
                onError={onError}
            />
        );
    }

    if (page === "transactions") {
        return (
            <TransactionsView
                data={data}
                month={month}
                view={txView}
                setView={setTxView}
                highlightIds={recentIds}
                onPickMonth={m => onPickMonth(m, true)}
                filter={filter}
                setFilter={setFilter}
                accountFilter={accountFilter}
                setAccountFilter={setAccountFilter}
                search={search}
                setSearch={setSearch}
                onOpenTx={t => {
                    onSelectTx(t);
                    onOpenDialog("detail");
                }}
                onAddAtDate={(date, kind) => onOpenEntry({ date, kind: kind || "expense" })}
                onScanAtDate={date => onOpenEntry({ date, kind: "expense", autoScan: true })}
                onTransferAtDate={date => onOpenEntry({ date, kind: "transfer" })}
                onSelectReview={r => {
                    onSelectReview(r);
                    onOpenDialog("review");
                }}
                onOpenAllReviews={() => onNav("reviews")}
                onReviewResolved={msg => {
                    onRefresh(true);
                    onShowToast(msg);
                }}
                onError={onError}
            />
        );
    }

    if (page === "budgets") {
        return (
            <BudgetsView
                data={data}
                month={month}
                onSelectCategory={catName => {
                    onNav("transactions");
                    setFilter(catName);
                }}
                onDone={() => {
                    onRefresh(true);
                    onShowToast("Anggaran & target diperbarui.");
                }}
            />
        );
    }

    if (page === "stats") {
        return (
            <StatisticsView
                data={data}
                month={month}
                onSelectCategory={catName => {
                    onNav("transactions");
                    setFilter(catName);
                }}
            />
        );
    }

    if (page === "reports") {
        return <ReportsView data={data} month={month} demoMode={demoMode} setMonth={m => onPickMonth(m, true)} />;
    }

    if (page === "import") {
        return (
            <ImporterView
                data={data}
                demoMode={demoMode}
                onLogin={() => onOpenDialog("login")}
                onDone={() => onRefresh(true)}
            />
        );
    }

    if (page === "masters") {
        return (
            <MastersView
                data={data}
                onEditAccount={a => {
                    onSelectAccount(a);
                    onOpenDialog("edit-account");
                }}
                onAddAccount={() => {
                    onSelectAccount(null);
                    onOpenDialog("account");
                }}
                onTransfer={fromAccId => onOpenEntry({ kind: "transfer", account_id: fromAccId })}
                onFilterAccount={accId => {
                    onNav("transactions");
                    setAccountFilter(accId);
                }}
                onAddCategory={() => onOpenDialog("category")}
                onEditCategory={c => {
                    onSelectCategory(c);
                    onOpenDialog("edit-category");
                }}
                onOpenImport={() => onNav("import")}
            />
        );
    }

    if (page === "settings") {
        return (
            <SettingsView
                data={data}
                month={month}
                demoMode={demoMode}
                theme={theme}
                onToggleTheme={onToggleTheme}
                onDone={nextStartDay => {
                    if (typeof nextStartDay === "number") {
                        onPickMonth(cycleMonthForDate(today(), nextStartDay), false);
                    }
                    onRefresh(true);
                    onShowToast("Pengaturan disimpan.");
                }}
            />
        );
    }

    return (
        <ReviewsView
            data={data}
            reviews={data.reviews}
            highlightIds={recentIds}
            onSelect={r => {
                onSelectReview(r);
                onOpenDialog("review");
            }}
            onResolved={msg => {
                onRefresh(true);
                onShowToast(msg);
            }}
        />
    );
}
