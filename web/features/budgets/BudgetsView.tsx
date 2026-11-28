"use client";
import { useState, type FormEvent } from "react";
import {
    AlertTriangle,
    ArrowRight,
    CheckCircle2,
    Pencil,
    Plus,
    ShieldAlert,
    Sparkles,
    Trash2,
    Wallet,
} from "lucide-react";
import { CatIcon, ErrorNote } from "../../components/ui";
import { del, post } from "../../lib/api";
import { type Budget, type Data, expense, formatDots, money, parseDigits, period } from "../../lib/domain";
import { GoalsPanel } from "./GoalsPanel";

export function BudgetsView({
    data,
    month,
    onSelectCategory,
    onDone,
}: {
    data: Data;
    month: string;
    onSelectCategory?: (name: string) => void;
    onDone: () => void;
}) {
    const expenseCategories = data.categories.filter(c => c.kind === "expense" && !c.archived);
    const budgets = data.budgets || [];
    const [catId, setCatId] = useState<string>(expenseCategories[0]?.id || "");
    const [amount, setAmount] = useState<string>("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const startDay = data.settings?.monthly_start_day || 1;
    const range = period(month, startDay);
    const endMs = new Date(range.end + "T23:59:59").getTime();
    const pacing = data.summary?.pacing;
    const remainingDays = pacing?.days_remaining ?? Math.max(1, Math.ceil((endMs - Date.now()) / 86400000));
    const alerts = data.summary?.budget_alerts || budgets.filter(b => b.status === "warning" || b.status === "over");

    const totalBudget = pacing?.total_budget ?? budgets.reduce((sum, b) => sum + b.amount, 0);
    const totalSpent = pacing?.total_budget_spent ?? budgets.reduce((sum, b) => sum + b.spent, 0);
    const totalRemaining = pacing?.budget_remaining ?? totalBudget - totalSpent;
    const totalPct = pacing?.budget_spent_percent ?? (totalBudget > 0 ? Math.round((100 * totalSpent) / totalBudget) : 0);
    const safeDailyTotal =
        pacing && totalBudget > 0
            ? pacing.safe_daily_allowance
            : totalRemaining > 0
              ? Math.floor(totalRemaining / Math.max(1, remainingDays))
              : 0;

    const unbudgetedCategories = expenseCategories.filter(c => !budgets.some(b => b.category_id === c.id));

    async function saveBudget(e: FormEvent<HTMLFormElement>) {
        e.preventDefault();
        const num = parseDigits(amount);
        if (!catId || !num || num <= 0) {
            setError("Pilih kategori pengeluaran dan isi nominal anggaran.");
            return;
        }
        setBusy(true);
        setError("");
        try {
            await post("/budgets", { category_id: catId, amount: num });
            setAmount("");
            onDone();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Gagal menyimpan anggaran.");
        } finally {
            setBusy(false);
        }
    }

    async function removeBudget(b: Budget) {
        setBusy(true);
        setError("");
        try {
            await del("/budgets/" + b.id);
            onDone();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Gagal menghapus anggaran.");
        } finally {
            setBusy(false);
        }
    }

    function selectForEdit(categoryId: string, currentAmount?: number) {
        setCatId(categoryId);
        setAmount(currentAmount ? String(currentAmount) : "");
        window.scrollTo({ top: 0, behavior: "smooth" });
    }

    return (
        <div className="stack">
            <section className="budget-hero card">
                <div className="budget-hero-grid">
                    <div>
                        <small className="muted">Total anggaran bulanan</small>
                        <h2>{money(totalBudget)}</h2>
                    </div>
                    <div>
                        <small className="muted">Terpakai siklus ini</small>
                        <h2 className="expense-amt">−{money(totalSpent)}</h2>
                    </div>
                    <div>
                        <small className="muted">{totalRemaining >= 0 ? "Sisa anggaran" : "Melebihi anggaran"}</small>
                        <h2 className={totalRemaining >= 0 ? "income" : "expense-amt"}>
                            {money(Math.abs(totalRemaining))}
                        </h2>
                        {totalRemaining > 0 && (
                            <small className="safe-daily-pill">
                                <Sparkles size={12} /> Aman {money(safeDailyTotal)} / hari ({remainingDays} hari tersisa)
                            </small>
                        )}
                    </div>
                </div>
                {totalBudget > 0 && (
                    <div className="pacing-strip" style={{ marginTop: 14 }}>
                        <div className="bar-line">
                            <span className="bar-track" style={{ height: 10 }}>
                                <span
                                    className={
                                        "bar " +
                                        (totalPct > 100 ? "bar-over" : totalPct >= 80 ? "bar-warn" : "bar-safe")
                                    }
                                    style={{ width: Math.min(100, Math.max(2, totalPct)) + "%" }}
                                />
                            </span>
                            <small>
                                <b>{totalPct}%</b> anggaran terpakai
                            </small>
                        </div>
                        {pacing && (
                            <div className="bar-line" style={{ marginTop: 6 }}>
                                <span className="bar-track" style={{ height: 6 }}>
                                    <span
                                        className="bar bar-muted"
                                        style={{ width: Math.min(100, Math.max(2, pacing.elapsed_percent)) + "%" }}
                                    />
                                </span>
                                <small className="muted">
                                    {pacing.elapsed_percent}% waktu siklus ({pacing.days_elapsed}/{pacing.days_total} hari)
                                </small>
                            </div>
                        )}
                    </div>
                )}
            </section>

            {alerts.length > 0 && (
                <div className={"budget-alert-banner " + (alerts.some(a => a.status === "over") ? "over" : "warning")}>
                    <div className="budget-alert-text">
                        {alerts.some(a => a.status === "over") ? <ShieldAlert size={16} /> : <AlertTriangle size={16} />}
                        <span>
                            <strong>Peringatan Anggaran:</strong>{" "}
                            {alerts.map(a => `${a.category_name} (${a.percent}%)`).join(" · ")}
                        </span>
                    </div>
                </div>
            )}

            <div className="two-cols">
                <section className="card">
                    <div className="section-title">
                        <h2>Anggaran per kategori</h2>
                        <Wallet size={18} />
                    </div>
                    {budgets.length ? (
                        <div className="budget-list">
                            {budgets.map(b => {
                                const statusLabel =
                                    b.status === "over"
                                        ? "Over-budget"
                                        : b.status === "warning"
                                          ? "Hampir habis"
                                          : "Aman";
                                const StatusIcon =
                                    b.status === "over"
                                        ? ShieldAlert
                                        : b.status === "warning"
                                          ? AlertTriangle
                                          : CheckCircle2;
                                const catSafeDaily = b.remaining > 0 ? Math.floor(b.remaining / remainingDays) : 0;

                                return (
                                    <div key={b.id} className="budget-card-row">
                                        <div className="budget-row-top">
                                            <div className="budget-cat-title">
                                                <span className="cat-icon">
                                                    <CatIcon name={b.category_name} />
                                                </span>
                                                <div>
                                                    <strong>{b.category_name}</strong>
                                                    <span className={"budget-badge " + b.status}>
                                                        <StatusIcon size={12} /> {statusLabel} ({b.percent}%)
                                                    </span>
                                                </div>
                                            </div>
                                            <div className="btns">
                                                {onSelectCategory && (
                                                    <button
                                                        type="button"
                                                        className="btn sm"
                                                        title="Lihat transaksi kategori ini"
                                                        onClick={() => onSelectCategory(b.category_name)}
                                                    >
                                                        Transaksi <ArrowRight size={13} />
                                                    </button>
                                                )}
                                                <button
                                                    type="button"
                                                    className="icon-btn"
                                                    title="Ubah anggaran"
                                                    onClick={() => selectForEdit(b.category_id, b.amount)}
                                                >
                                                    <Pencil size={15} />
                                                </button>
                                                <button
                                                    type="button"
                                                    className="icon-btn"
                                                    title="Hapus anggaran"
                                                    disabled={busy}
                                                    onClick={() => removeBudget(b)}
                                                >
                                                    <Trash2 size={15} />
                                                </button>
                                            </div>
                                        </div>

                                        <div className="bar-line">
                                            <span className="bar-track" style={{ height: 8 }}>
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
                                        </div>

                                        <div className="budget-row-meta">
                                            <span>
                                                Terpakai: <b className="expense-amt">{money(b.spent)}</b> dari{" "}
                                                <b>{money(b.amount)}</b>
                                            </span>
                                            <span className={b.remaining >= 0 ? "income" : "expense-amt"}>
                                                {b.remaining >= 0
                                                    ? `Sisa ${money(b.remaining)} (${money(catSafeDaily)}/hr)`
                                                    : `Lewat ${money(Math.abs(b.remaining))}`}
                                            </span>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <p className="empty">
                            Belum ada anggaran kategori. Tetapkan anggaran bulanan di panel samping untuk memantau
                            pengeluaran.
                        </p>
                    )}
                </section>

                <div className="stack">
                    <section className="card">
                        <div className="section-title">
                            <h2>Atur anggaran kategori</h2>
                            <Plus size={18} />
                        </div>
                        {expenseCategories.length ? (
                            <form className="form" onSubmit={saveBudget}>
                                <div className="field">
                                    <span>Pilih Kategori Pengeluaran</span>
                                    <div className="cat-chip-grid">
                                        {expenseCategories.map(c => (
                                            <button
                                                type="button"
                                                key={c.id}
                                                className={`cat-pick-chip expense ${catId === c.id ? "active" : ""}`}
                                                onClick={() => {
                                                    setCatId(c.id);
                                                    const ex = budgets.find(b => b.category_id === c.id);
                                                    if (ex) setAmount(String(ex.amount));
                                                }}
                                            >
                                                <CatIcon name={c.name} size={15} />
                                                <span>{c.name}</span>
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                <div className="amount-hero-box">
                                    <span className="amount-hero-label">Batas Anggaran per Siklus Bulan</span>
                                    <div className="amount-hero-input-row">
                                        <span className="currency-prefix">Rp</span>
                                        <input
                                            type="text"
                                            inputMode="numeric"
                                            required
                                            aria-label="Batas anggaran per bulan (Rp)"
                                            value={formatDots(amount)}
                                            onChange={e => setAmount(e.target.value.replace(/\D/g, ""))}
                                            placeholder="0"
                                        />
                                    </div>
                                    <div className="quick-nominal-row">
                                        {[300000, 500000, 1000000, 1500000, 2000000, 3000000].map(preset => (
                                            <button
                                                key={preset}
                                                type="button"
                                                className="nominal-chip"
                                                onClick={() => setAmount(String(preset))}
                                            >
                                                {preset >= 1000000 ? `${preset / 1000000}jt` : `${preset / 1000}rb`}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                <ErrorNote message={error} />
                                <button type="submit" className="btn primary" disabled={busy}>
                                    {busy ? "Menyimpan…" : "Simpan anggaran"}
                                </button>
                            </form>
                        ) : (
                            <p className="empty">Buat kategori pengeluaran di Master data terlebih dahulu.</p>
                        )}
                    </section>

                    <GoalsPanel goals={data.goals || []} onDone={onDone} />

                    {unbudgetedCategories.length > 0 && (
                        <section className="card">
                            <div className="section-title">
                                <h2>Kategori belum beranggaran</h2>
                            </div>
                            {unbudgetedCategories.map(c => {
                                const spent = data.transactions
                                    .filter(t => t.category_id === c.id)
                                    .reduce((s, t) => s + expense(t), 0);
                                return (
                                    <div key={c.id} className="paper-line">
                                        <span>
                                            <strong>{c.name}</strong>
                                            <small>Terpakai siklus ini: {money(spent)}</small>
                                        </span>
                                        <button
                                            type="button"
                                            className="btn sm"
                                            onClick={() =>
                                                selectForEdit(
                                                    c.id,
                                                    spent > 0 ? Math.ceil(spent / 100000) * 100000 : 500000
                                                )
                                            }
                                        >
                                            + Atur anggaran
                                        </button>
                                    </div>
                                );
                            })}
                        </section>
                    )}
                </div>
            </div>
        </div>
    );
}
