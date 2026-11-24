"use client";
import {
    ArrowDownLeft,
    ArrowLeftRight,
    ArrowRight,
    ArrowUpRight,
    Camera,
    ChevronRight,
    Coins,
    Flame,
    Inbox,
    Landmark,
    ListFilter,
    Pencil,
    PieChart,
    Plus,
    ShieldAlert,
    ShieldCheck,
    Smartphone,
    TrendingDown,
    TrendingUp,
    Wallet,
} from "lucide-react";
import {
    type Account,
    type Data,
    type Transaction,
    accountKindLabels,
    expense,
    money,
    period,
} from "../lib/domain";
import { CatIcon, TxList } from "./ui";

export function Categories({
    data,
    onSelect,
}: {
    data: Data;
    onSelect: (name: string) => void;
}) {
    const cats = data.summary.categories.filter(c => c.amount > 0).sort((a, b) => b.amount - a.amount);
    const budgetsByName = new Map((data.budgets || []).map(b => [b.category_name, b]));
    return (
        <div className="categories">
            {cats.length ? (
                cats.map((c, i) => {
                    const b = budgetsByName.get(c.name);
                    const pct = data.summary.expense > 0 ? Math.round((100 * c.amount) / data.summary.expense) : 0;
                    return (
                        <button key={c.name} className="category-row" onClick={() => onSelect(c.name)}>
                            <span className="cat-icon">
                                <CatIcon name={c.name} />
                            </span>
                            <span className="category-text">
                                <span className="category-label">
                                    <strong>{c.name}</strong>
                                    <b>{money(c.amount)}</b>
                                </span>
                                <span className="bar-line">
                                    <span className="bar-track">
                                        <span
                                            className={
                                                "bar " +
                                                (b
                                                    ? b.status === "over"
                                                        ? "bar-over"
                                                        : b.status === "warning"
                                                          ? "bar-warn"
                                                          : "bar-safe"
                                                    : "bar-" + (i % 5))
                                            }
                                            style={{
                                                width:
                                                    Math.min(
                                                        100,
                                                        Math.max(2, b ? b.percent : (100 * c.amount) / cats[0].amount)
                                                    ) + "%",
                                            }}
                                        />
                                    </span>
                                    <small>{b ? `${b.percent}% dari anggaran` : `${pct}%`}</small>
                                </span>
                            </span>
                        </button>
                    );
                })
            ) : (
                <p className="empty">Kategori pengeluaran muncul setelah transaksi pertama.</p>
            )}
        </div>
    );
}

function SpendingLine({
    rows,
    month,
    startDay,
}: {
    rows: Transaction[];
    month: string;
    startDay: number;
}) {
    const range = period(month, startDay);
    const startMs = new Date(range.start + "T12:00:00").getTime();
    const endMs = new Date(range.end + "T12:00:00").getTime();
    const days = Math.max(1, Math.round((endMs - startMs) / 86400000) + 1);
    const dayTotals = Array(days).fill(0) as number[];
    for (const t of rows) {
        const ms = new Date(t.date.slice(0, 10) + "T12:00:00").getTime();
        const idx = Math.round((ms - startMs) / 86400000);
        if (idx >= 0 && idx < days) dayTotals[idx] += expense(t);
    }
    let sum = 0;
    const cumulative = dayTotals.map(v => (sum += v));
    const max = Math.max(1, ...cumulative);
    const min = Math.min(0, ...cumulative);
    const w = 320;
    const h = 86;
    const points = [0, ...cumulative].map((n, i) => [
        2 + (i / days) * (w - 4),
        h - 8 - ((n - min) / (max - min || 1)) * (h - 16),
    ]);
    const line = points.map(p => p.join(",")).join(" ");
    const last = points[points.length - 1];
    return (
        <div className="spend-graph">
            <div className="graph-label">Kurva pengeluaran kumulatif</div>
            <svg viewBox={"0 0 " + w + " " + h} role="img" aria-label="Tren pengeluaran kumulatif">
                <defs>
                    <linearGradient id="spend-fill" x1="0" x2="0" y1="0" y2="1">
                        <stop offset="0%" stopColor="#e2e8f0" stopOpacity=".22" />
                        <stop offset="100%" stopColor="#e2e8f0" stopOpacity="0" />
                    </linearGradient>
                </defs>
                {[0.2, 0.55, 0.9].map(y => (
                    <line
                        key={y}
                        x1="0"
                        y1={h * y}
                        x2={w}
                        y2={h * y}
                        stroke="#ffffff"
                        strokeOpacity=".12"
                        strokeDasharray="3 5"
                    />
                ))}
                <polygon points={"2," + h + " " + line + " " + (w - 2) + "," + h} fill="url(#spend-fill)" />
                <polyline
                    points={line}
                    fill="none"
                    stroke="#e2e8f0"
                    strokeWidth="2.2"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                />
                <circle cx={last[0]} cy={last[1]} r="3.5" fill="#ffffff" />
            </svg>
            <div className="graph-labels">
                <span>Tgl {Number(range.start.slice(8))}</span>
                <span>Tgl {Number(range.end.slice(8))}</span>
            </div>
        </div>
    );
}

export function Accounts({
    data,
    onOpen,
    onEdit,
    onTransfer,
    onFilterAccount,
    onAdd,
}: {
    data: Data;
    onOpen?: () => void;
    onEdit?: (a: Account) => void;
    onTransfer?: (fromAccountId?: string) => void;
    onFilterAccount?: (accountId: string) => void;
    onAdd?: () => void;
}) {
    const totalBalance = data.accounts.reduce((acc, a) => acc + Math.max(0, a.balance || 0), 0);
    return (
        <section className="card">
            <div className="section-title">
                <div>
                    <h2>Dompet Saya</h2>
                    <small className="muted">Total aset likuid: {money(totalBalance)}</small>
                </div>
                <div className="btns">
                    {onTransfer && data.accounts.length >= 2 && (
                        <button
                            type="button"
                            className="btn sm"
                            onClick={() => onTransfer()}
                            title="Transfer antar dompet"
                        >
                            <ArrowLeftRight size={14} /> Transfer
                        </button>
                    )}
                    {onAdd && (
                        <button type="button" className="btn primary sm" onClick={onAdd} aria-label="Tambah dompet">
                            <Plus size={14} /> Dompet
                        </button>
                    )}
                    {!onAdd && <Wallet size={18} />}
                </div>
            </div>
            {data.accounts.length ? (
                <div className="wallet-cards-grid">
                    {data.accounts.map(a => {
                        const kindKey =
                            a.kind === "bank" || /bca|bank|mandiri|bri|bni|jago/i.test(a.name)
                                ? "bank"
                                : a.kind === "cash" || /tunai|cash/i.test(a.name)
                                  ? "cash"
                                  : "ewallet";
                        const Icon = kindKey === "bank" ? Landmark : kindKey === "cash" ? Coins : Smartphone;
                        const pct =
                            totalBalance > 0 && (a.balance || 0) > 0
                                ? Math.round((100 * (a.balance || 0)) / totalBalance)
                                : 0;
                        const isDefault = data.settings?.default_account_id === a.id;

                        return (
                            <div key={a.id} className={`wallet-visual-card ${kindKey}`}>
                                <div className="wvc-top">
                                    <div className="wvc-brand">
                                        <span className={`wvc-icon ${kindKey}`}>
                                            <Icon size={18} />
                                        </span>
                                        <div>
                                            <strong>{a.name}</strong>
                                            <small>
                                                {accountKindLabels[a.kind || kindKey] || "Dompet"}
                                                {isDefault ? " · Utama" : ""}
                                            </small>
                                        </div>
                                    </div>
                                    <span className="wvc-share">{pct}%</span>
                                </div>

                                <div className="wvc-balance">
                                    {a.balance == null ? "Saldo belum diatur" : money(a.balance)}
                                </div>

                                <div className="wvc-actions">
                                    {onFilterAccount && (
                                        <button
                                            type="button"
                                            className="wvc-action-btn"
                                            onClick={() => onFilterAccount(a.id)}
                                            title="Lihat mutasi dompet ini"
                                        >
                                            <ListFilter size={13} /> Mutasi
                                        </button>
                                    )}
                                    {onTransfer && data.accounts.length >= 2 && (
                                        <button
                                            type="button"
                                            className="wvc-action-btn"
                                            onClick={() => onTransfer(a.id)}
                                            title="Transfer dari dompet ini"
                                        >
                                            <ArrowLeftRight size={13} /> Transfer
                                        </button>
                                    )}
                                    {onEdit && (
                                        <button
                                            type="button"
                                            className="wvc-action-btn"
                                            onClick={() => onEdit(a)}
                                            title="Ubah atau hapus dompet"
                                        >
                                            <Pencil size={13} /> Edit
                                        </button>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            ) : onAdd || onOpen ? (
                <button onClick={onAdd || onOpen} className="text-btn">
                    + Tambah dompet pertama
                </button>
            ) : (
                <p className="empty">Belum ada dompet.</p>
            )}
        </section>
    );
}

export function Dashboard({
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
    const nowMs = Math.min(endMs, Math.max(startMs, new Date().getTime()));
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

            {/* Smart Financial Insights Row */}
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

                <div
                    className="insight-card"
                    onClick={onStats}
                    style={{ cursor: onStats ? "pointer" : "default" }}
                >
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
                        <Categories data={data} onSelect={onCategory} />
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
                    <Accounts
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
