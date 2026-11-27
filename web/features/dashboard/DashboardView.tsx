"use client";
import { ArrowDownLeft, ArrowRight, ArrowUpRight, Plus, Sparkles } from "lucide-react";
import { TxList } from "../../components/ui";
import { type Account, type Data, type Review, type Transaction, money, period } from "../../lib/domain";
import { PendingDraftsBanner } from "../reviews/PendingDraftsBanner";
import { AccountsSection } from "./AccountsSection";
import { CategoriesBreakdown } from "./CategoriesBreakdown";

export function DashboardView({
    data,
    month,
    highlightIds,
    onCategory,
    onTx,
    onAll,
    onAccounts,
    onEditAccount,
    onAddAccount,
    onFilterAccount,
    onNewTx,
    onTransfer,
    onBudgets,
    onStats,
    onSelectReview,
    onReview,
    onReviewResolved,
    onError,
}: {
    data: Data;
    month: string;
    highlightIds?: Set<string>;
    onCategory: (c: string) => void;
    onTx: (t: Transaction) => void;
    onAll: () => void;
    onAccounts: () => void;
    onEditAccount?: (a: Account) => void;
    onAddAccount?: () => void;
    onFilterAccount?: (accountId: string) => void;
    onNewTx?: () => void;
    onTransfer?: (fromAccountId?: string) => void;
    onBudgets?: () => void;
    onStats?: () => void;
    onSelectReview: (r: Review) => void;
    onReview: () => void;
    onReviewResolved: (msg: string) => void;
    onError?: (msg: string) => void;
}) {
    const s = data.summary;
    const startDay = data.settings?.monthly_start_day || 1;
    const range = period(month, startDay);
    const totalWalletBalance = data.accounts.reduce((acc, a) => acc + (a.balance || 0), 0);

    const budgets = data.budgets || [];
    const totalBudget = budgets.reduce((sum, b) => sum + b.amount, 0);
    const totalBudgetSpent = budgets.reduce((sum, b) => sum + b.spent, 0);
    const budgetRemaining = totalBudget - totalBudgetSpent;
    const endMs = new Date(range.end + "T23:59:59").getTime();
    const remainingDays = Math.max(1, Math.ceil((endMs - Date.now()) / 86400000));
    const safeDaily = totalBudget > 0 && budgetRemaining > 0 ? Math.floor(budgetRemaining / remainingDays) : null;

    return (
        <div className="dashboard-clean-stack">
            {/* ZONA 1: Alert Draf Tinjauan + Kartu Ringkasan Utama */}
            <PendingDraftsBanner
                data={data}
                highlightIds={highlightIds}
                onSelectReview={onSelectReview}
                onOpenAllReviews={onReview}
                onResolved={onReviewResolved}
                onError={onError}
            />

            <section className="hero clean-hero">
                <div className="clean-hero-main">
                    <div>
                        <p className="hero-eyebrow">Total Saldo Seluruh Dompet</p>
                        <h2>{money(totalWalletBalance)}</h2>
                    </div>
                    {safeDaily !== null && (
                        <button
                            type="button"
                            className="hero-safe-pill"
                            onClick={onBudgets}
                            title="Batas belanja aman per hari dari sisa anggaran"
                        >
                            <Sparkles size={13} />
                            <span>Aman {money(safeDaily)} / hari</span>
                        </button>
                    )}
                </div>

                <div className="hero-bottom three-kpis">
                    <div>
                        <span className="hero-mini">
                            <ArrowDownLeft size={14} /> Pemasukan Siklus Ini
                        </span>
                        <strong className="hero-income">+{money(s.income)}</strong>
                    </div>
                    <div>
                        <span className="hero-mini">
                            <ArrowUpRight size={14} /> Pengeluaran Siklus Ini
                        </span>
                        <strong className="hero-expense">−{money(s.expense)}</strong>
                    </div>
                    <div>
                        <span className="hero-mini">Selisih Arus Kas</span>
                        <strong>
                            {s.net > 0 ? "+" : ""}
                            {money(s.net)}
                        </strong>
                    </div>
                </div>
            </section>

            {s.partial_history && (
                <p className="partial-note">
                    Riwayat sebagian · Periode memuat transaksi sebelum tanggal saldo awal.
                </p>
            )}

            {/* ZONA 2: Deretan Dompet Saya (Sejajar & Ringkas) */}
            <AccountsSection
                data={data}
                horizontal
                onOpen={onAccounts}
                onEdit={onEditAccount}
                onTransfer={onTransfer}
                onFilterAccount={onFilterAccount}
                onAdd={onAddAccount}
            />

            {/* ZONA 3: Dua Kolom Seimbang (Transaksi Terakhir & Pantauan Anggaran / Pos Terbesar) */}
            <div className="dashboard-grid">
                <section className="card recent">
                    <div className="section-title">
                        <h2>Transaksi Terakhir</h2>
                        <div className="btns">
                            {onNewTx && (
                                <button type="button" className="btn sm" onClick={onNewTx}>
                                    <Plus size={14} /> Catat
                                </button>
                            )}
                            <button className="text-btn" onClick={onAll} aria-label="Semua transaksi">
                                Lihat semua <ArrowRight size={15} />
                            </button>
                        </div>
                    </div>
                    <TxList
                        rows={data.transactions.slice(0, 6)}
                        accounts={data.accounts}
                        open={onTx}
                        highlightIds={highlightIds}
                    />
                </section>

                <div className="stack">
                    {budgets.length > 0 && (
                        <section className="card">
                            <div className="section-title">
                                <h2>Pantauan Anggaran</h2>
                                {onBudgets && (
                                    <button className="text-btn" onClick={onBudgets}>
                                        Kelola <ArrowRight size={15} />
                                    </button>
                                )}
                            </div>
                            <div className="budget-mini-list">
                                {budgets.slice(0, 4).map(b => (
                                    <div
                                        key={b.id}
                                        className="budget-mini-row clickable"
                                        onClick={() => onCategory(b.category_name)}
                                        title={`Klik untuk lihat transaksi ${b.category_name}`}
                                    >
                                        <div className="category-label">
                                            <strong>{b.category_name}</strong>
                                            <span>
                                                <b className={b.status === "over" ? "expense-amt" : ""}>
                                                    {money(b.spent)}
                                                </b>{" "}
                                                <small className="muted">/ {money(b.amount)}</small>
                                            </span>
                                        </div>
                                        <div className="bar-line">
                                            <span className="bar-track">
                                                <span
                                                    className={
                                                        "bar " +
                                                        (b.status === "over"
                                                            ? "bar-over"
                                                            : b.status === "warning"
                                                              ? "bar-warn"
                                                              : "bar-safe")
                                                    }
                                                    style={{ width: Math.min(100, Math.max(2, b.percent)) + "%" }}
                                                />
                                            </span>
                                            <small className={"budget-status-text " + b.status}>{b.percent}%</small>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </section>
                    )}

                    <section className="card">
                        <div className="section-title">
                            <h2>Pos Pengeluaran Terbesar</h2>
                            {onStats && (
                                <button className="text-btn" onClick={onStats}>
                                    Statistik <ArrowRight size={15} />
                                </button>
                            )}
                        </div>
                        <CategoriesBreakdown data={data} limit={5} onSelect={onCategory} />
                    </section>
                </div>
            </div>
        </div>
    );
}
