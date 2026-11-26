"use client";
import {
    ArrowDownLeft,
    ArrowLeftRight,
    ArrowRight,
    ArrowUpRight,
    Camera,
    ChevronRight,
    Flame,
    Inbox,
    PieChart,
    Plus,
    ShieldAlert,
    ShieldCheck,
    TrendingDown,
    TrendingUp,
} from "lucide-react";
import { TxList } from "../../components/ui";
import { type Account, type Data, type Transaction, money, period } from "../../lib/domain";
import { AccountsSection } from "./AccountsSection";
import { CategoriesBreakdown } from "./CategoriesBreakdown";
import { SpendingLine } from "./SpendingLine";

export function DashboardView({
    data,
    month,
    onCategory,
    onTx,
    onAll,
    onAccounts,
    onEditAccount,
    onAddAccount,
    onFilterAccount,
    onNewTx,
    onScanReceipt,
    onTransfer,
    onBudgets,
    onStats,
    onReview,
}: {
    data: Data;
    month: string;
    onCategory: (c: string) => void;
    onTx: (t: Transaction) => void;
    onAll: () => void;
    onAccounts: () => void;
    onEditAccount?: (a: Account) => void;
    onAddAccount?: () => void;
    onFilterAccount?: (accountId: string) => void;
    onNewTx?: () => void;
    onScanReceipt?: () => void;
    onTransfer?: (fromAccountId?: string) => void;
    onBudgets?: () => void;
    onStats?: () => void;
    onReview: () => void;
}) {
    const s = data.summary;
    const startDay = data.settings?.monthly_start_day || 1;
    const range = period(month, startDay);
    const totalWalletBalance = data.accounts.reduce((acc, a) => acc + (a.balance || 0), 0);
    const savingsRate = s.income > 0 ? Math.round(((s.income - s.expense) / s.income) * 100) : 0;

    const startMs = new Date(range.start + "T12:00:00").getTime();
    const endMs = new Date(range.end + "T12:00:00").getTime();
    const nowMs = Math.min(endMs, Math.max(startMs, Date.now()));
    const totalDays = Math.max(1, Math.round((endMs - startMs) / 86400000) + 1);
    const elapsedDays = Math.max(1, Math.min(totalDays, Math.round((nowMs - startMs) / 86400000) + 1));
    const dailyBurn = Math.round(s.expense / elapsedDays);
    const projectedExpense = Math.round(dailyBurn * totalDays);

    const prevExp = s.previous?.expense || 0;
    const expChangePct = prevExp > 0 ? Math.round(((s.expense - prevExp) / prevExp) * 100) : null;

    const budgets = data.budgets || [];
    const totalBudget = budgets.reduce((sum, b) => sum + b.amount, 0);
    const totalBudgetSpent = budgets.reduce((sum, b) => sum + b.spent, 0);
    const budgetPct = totalBudget > 0 ? Math.round((100 * totalBudgetSpent) / totalBudget) : 0;
    const overCount = budgets.filter(b => b.status === "over").length;
    const warnCount = budgets.filter(b => b.status === "warning").length;
    const topCategory = s.categories[0];

    return (
        <>
            <section className="hero">
                <div className="hero-top">
                    <div>
                        <p className="hero-eyebrow">Total Kekayaan Likuid (Seluruh Dompet)</p>
                        <h2>{money(totalWalletBalance)}</h2>
                        <div className="hero-quick-actions">
                            {onNewTx && (
                                <button type="button" className="hero-btn primary" onClick={onNewTx}>
                                    <Plus size={15} /> Catat transaksi
                                </button>
                            )}
                            {onScanReceipt && (
                                <button type="button" className="hero-btn" onClick={onScanReceipt}>
                                    <Camera size={15} /> Foto struk
                                </button>
                            )}
                            {onTransfer && (
                                <button type="button" className="hero-btn" onClick={() => onTransfer()}>
                                    <ArrowLeftRight size={15} /> Transfer dompet
                                </button>
                            )}
                        </div>
                    </div>
                    <SpendingLine rows={data.transactions} month={month} startDay={startDay} />
                </div>
                <div className="hero-bottom">
                    <div>
                        <span className="hero-mini">
                            <ArrowDownLeft size={15} /> Uang Masuk
                        </span>
                        <strong className="hero-income">+{money(s.income)}</strong>
                    </div>
                    <div>
                        <span className="hero-mini">
                            <ArrowUpRight size={15} /> Uang Keluar
                        </span>
                        <strong className="hero-expense">−{money(s.expense)}</strong>
                    </div>
                    <div>
                        <span className="hero-mini">Arus Kas Bersih</span>
                        <strong>
                            {s.net > 0 ? "+" : ""}
                            {money(s.net)}
                        </strong>
                    </div>
                    <div>
                        <span className="hero-mini">Rasio Tabungan</span>
                        <strong>{s.income > 0 ? `${savingsRate}%` : "—"}</strong>
                    </div>
                </div>
            </section>

            <section className="insights-grid" aria-label="Insight keuangan">
                <div className="insight-card">
                    <div className="insight-icon">
                        <Flame size={18} />
                    </div>
                    <div>
                        <small>Rata-rata pengeluaran harian</small>
                        <strong>{money(dailyBurn)} / hari</strong>
                        <span>Proyeksi akhir siklus: {money(projectedExpense)}</span>
                    </div>
                </div>

                <div className="insight-card">
                    <div className={"insight-icon " + (expChangePct !== null && expChangePct <= 0 ? "good" : "warn")}>
                        {expChangePct !== null && expChangePct <= 0 ? (
                            <TrendingDown size={18} />
                        ) : (
                            <TrendingUp size={18} />
                        )}
                    </div>
                    <div>
                        <small>Perbandingan siklus lalu</small>
                        <strong>
                            {expChangePct === null
                                ? "Siklus pertama"
                                : expChangePct === 0
                                  ? "Stabil (0%)"
                                  : `${expChangePct > 0 ? "Naik +" : "Hemat "}${expChangePct}%`}
                        </strong>
                        <span>Siklus lalu: {money(prevExp)}</span>
                    </div>
                </div>

                <div
                    className="insight-card"
                    onClick={onBudgets}
                    style={{ cursor: onBudgets ? "pointer" : "default" }}
                >
                    <div className={"insight-icon " + (overCount > 0 ? "bad" : warnCount > 0 ? "warn" : "good")}>
                        {overCount > 0 || warnCount > 0 ? <ShieldAlert size={18} /> : <ShieldCheck size={18} />}
                    </div>
                    <div>
                        <small>Kesehatan anggaran bulanan</small>
                        <strong>{totalBudget > 0 ? `${budgetPct}% terpakai` : "Belum diatur"}</strong>
                        <span>
                            {totalBudget > 0
                                ? overCount > 0
                                    ? `${overCount} kategori over-budget`
                                    : warnCount > 0
                                      ? `${warnCount} kategori hampir habis`
                                      : `Sisa ${money(Math.max(0, totalBudget - totalBudgetSpent))}`
                                : "Klik untuk atur anggaran kategori"}
                        </span>
                    </div>
                </div>

                <div className="insight-card" onClick={onStats} style={{ cursor: onStats ? "pointer" : "default" }}>
                    <div className="insight-icon">
                        <PieChart size={18} />
                    </div>
                    <div>
                        <small>Pos pengeluaran terbesar</small>
                        <strong>{topCategory ? topCategory.name : "Belum ada"}</strong>
                        <span>
                            {topCategory && s.expense > 0
                                ? `${money(topCategory.amount)} (${Math.round((100 * topCategory.amount) / s.expense)}% dari total)`
                                : "Lihat grafik lengkap di Statistik"}
                        </span>
                    </div>
                </div>
            </section>

            {s.partial_history && (
                <p className="partial-note">
                    Riwayat sebagian · Periode memuat transaksi sebelum tanggal saldo awal.
                </p>
            )}

            <div className="dashboard-grid">
                <div className="stack">
                    <section className="card">
                        <div className="section-title">
                            <h2>Pengeluaran per kategori</h2>
                            {onStats && (
                                <button className="text-btn" onClick={onStats}>
                                    Analisis chart <ArrowRight size={15} />
                                </button>
                            )}
                        </div>
                        <CategoriesBreakdown data={data} onSelect={onCategory} />
                    </section>

                    <section className="card">
                        <div className="section-title">
                            <h2>Progres anggaran bulan ini</h2>
                            {onBudgets && (
                                <button className="text-btn" onClick={onBudgets}>
                                    Kelola anggaran <ArrowRight size={15} />
                                </button>
                            )}
                        </div>
                        {budgets.length ? (
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
                        ) : (
                            <p className="empty">
                                Belum ada anggaran kategori.{" "}
                                {onBudgets && (
                                    <button className="text-btn" onClick={onBudgets}>
                                        + Buat anggaran bulanan
                                    </button>
                                )}
                            </p>
                        )}
                    </section>
                </div>

                <div className="stack">
                    <AccountsSection
                        data={data}
                        onOpen={onAccounts}
                        onEdit={onEditAccount}
                        onTransfer={onTransfer}
                        onFilterAccount={onFilterAccount}
                        onAdd={onAddAccount}
                    />
                    {s.reviews > 0 && (
                        <button className="review-card" onClick={onReview}>
                            <Inbox size={22} />
                            <span>
                                <strong>Perlu ditinjau</strong>
                                <small>{s.reviews} bukti menunggu keputusan</small>
                            </span>
                            <ChevronRight size={16} />
                        </button>
                    )}
                    <section className="card recent">
                        <div className="section-title">
                            <h2>Transaksi terakhir</h2>
                            <button className="text-btn" onClick={onAll} aria-label="Semua transaksi">
                                Lihat semua <ArrowRight size={15} />
                            </button>
                        </div>
                        <TxList rows={data.transactions.slice(0, 5)} accounts={data.accounts} open={onTx} />
                    </section>
                </div>
            </div>
        </>
    );
}
