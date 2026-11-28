"use client";
import { useState } from "react";
import { ArrowDownLeft, ArrowUpRight, BarChart3, PieChart, TrendingUp, Wallet } from "lucide-react";
import { aggregateDailyTransactions, aggregateWeeklySeries } from "../../lib/charts";
import {
    type Data,
    compactMoney,
    money,
    period,
    weekdayShort,
} from "../../lib/domain";
import { DonutChart } from "./DonutChart";

export function StatisticsView({
    data,
    month,
    onSelectCategory,
}: {
    data: Data;
    month: string;
    onSelectCategory?: (name: string) => void;
}) {
    const [donutKind, setDonutKind] = useState<"expense" | "income">("expense");
    const [barMode, setBarMode] = useState<"daily" | "weekly">("daily");
    const [selectedBarIdx, setSelectedBarIdx] = useState<number | null>(null);

    const s = data.summary;
    const startDay = data.settings?.monthly_start_day || 1;
    const weekStart = data.settings?.weekly_start_day ?? 1;
    const range = period(month, startDay);
    const dailySeries = aggregateDailyTransactions(data.transactions, range.start, range.end);
    const weeklySeries = aggregateWeeklySeries(dailySeries, weekStart);

    const dowTotals = Array(7).fill(0) as number[];
    for (const d of dailySeries) dowTotals[d.dow] += d.expense;
    const orderedDows = Array.from({ length: 7 }, (_, i) => (weekStart + i) % 7);
    const maxDow = Math.max(1, ...dowTotals.map(v => Math.max(0, v)));

    const activeBars = barMode === "daily" ? dailySeries : weeklySeries;
    const maxBarValue = Math.max(1, ...activeBars.flatMap(b => [Math.max(0, b.income), Math.max(0, b.expense)]));
    const activeBarItem = selectedBarIdx !== null && activeBars[selectedBarIdx] ? activeBars[selectedBarIdx] : null;

    const incomeCats =
        s.income_categories && s.income_categories.length
            ? s.income_categories
            : (() => {
                  const map = new Map<string, number>();
                  for (const t of data.transactions) {
                      if (t.kind === "income") {
                          const name = t.category_name || "Pemasukan";
                          map.set(name, (map.get(name) || 0) + t.amount);
                      }
                  }
                  return Array.from(map.entries())
                      .map(([name, amount]) => ({ name, amount }))
                      .sort((a, b) => b.amount - a.amount);
              })();

    const prev = s.previous;
    const totalWallet = data.accounts.reduce((acc, a) => acc + Math.max(0, a.balance || 0), 0);

    return (
        <div className="stack">
            <section className="stats-kpi-grid">
                <div className="card stats-kpi">
                    <span className="stats-kpi-label">
                        <ArrowDownLeft size={16} className="income" /> Total Uang Masuk
                    </span>
                    <strong className="income">+{money(s.income)}</strong>
                    {prev && <small className="muted">Siklus lalu: {money(prev.income)}</small>}
                </div>
                <div className="card stats-kpi">
                    <span className="stats-kpi-label">
                        <ArrowUpRight size={16} className="expense-amt" /> Total Uang Keluar
                    </span>
                    <strong className="expense-amt">−{money(s.expense)}</strong>
                    {prev && <small className="muted">Siklus lalu: {money(prev.expense)}</small>}
                </div>
                <div className="card stats-kpi">
                    <span className="stats-kpi-label">
                        <TrendingUp size={16} /> Selisih Arus Kas
                    </span>
                    <strong className={s.net >= 0 ? "income" : "expense-amt"}>
                        {s.net > 0 ? "+" : ""}
                        {money(s.net)}
                    </strong>
                    <small className="muted">
                        Rasio tabungan:{" "}
                        {s.income > 0 ? `${Math.round(((s.income - s.expense) / s.income) * 100)}%` : "0%"}
                    </small>
                </div>
            </section>

            <div className="two-cols">
                <section className="card">
                    <div className="section-title">
                        <div>
                            <h2>Proporsi kategori</h2>
                            <small className="muted">Klik kategori untuk melihat rincian transaksinya</small>
                        </div>
                        <div className="segmented-pills">
                            <button
                                type="button"
                                className={donutKind === "expense" ? "active expense-pill" : ""}
                                onClick={() => setDonutKind("expense")}
                            >
                                Uang Keluar
                            </button>
                            <button
                                type="button"
                                className={donutKind === "income" ? "active income-pill" : ""}
                                onClick={() => setDonutKind("income")}
                            >
                                Uang Masuk
                            </button>
                        </div>
                    </div>
                    <DonutChart
                        items={donutKind === "expense" ? s.categories : incomeCats}
                        total={donutKind === "expense" ? s.expense : s.income}
                        kind={donutKind}
                        onSelectCategory={onSelectCategory}
                    />
                </section>

                <div className="stack">
                    <section className="card">
                        <div className="section-title">
                            <h2>Perbandingan siklus lalu</h2>
                            <BarChart3 size={18} />
                        </div>
                    {prev ? (
                        <div className="comparison-bars">
                            {[
                                {
                                    label: "Uang Masuk",
                                    curr: s.income,
                                    old: prev.income,
                                    cls: "bar-safe",
                                    textCls: "income",
                                },
                                {
                                    label: "Uang Keluar",
                                    curr: s.expense,
                                    old: prev.expense,
                                    cls: "bar-over",
                                    textCls: "expense-amt",
                                },
                            ].map(row => {
                                const safeCurr = Math.max(0, row.curr);
                                const safeOld = Math.max(0, row.old);
                                const maxVal = Math.max(1, safeCurr, safeOld);
                                return (
                                    <div key={row.label} className="comp-group">
                                        <div className="category-label">
                                            <strong>{row.label}</strong>
                                            <b className={row.textCls}>{money(row.curr)}</b>
                                        </div>
                                        <div className="bar-line">
                                            <span className="bar-track" style={{ height: 8 }}>
                                                <span
                                                    className={"bar " + row.cls}
                                                    style={{ width: Math.max(2, (100 * safeCurr) / maxVal) + "%" }}
                                                />
                                            </span>
                                            <small>Siklus ini</small>
                                        </div>
                                        <div className="bar-line">
                                            <span className="bar-track" style={{ height: 6 }}>
                                                <span
                                                    className="bar bar-muted"
                                                    style={{ width: Math.max(2, (100 * safeOld) / maxVal) + "%" }}
                                                />
                                            </span>
                                            <small>Lalu ({compactMoney(row.old)})</small>
                                        </div>
                                    </div>
                                );
                            })}
                            {s.category_deltas && s.category_deltas.length > 0 && (
                                <div className="delta-list">
                                    <small className="muted">Perubahan kategori terbesar</small>
                                    {s.category_deltas.slice(0, 5).map(d => (
                                        <div
                                            key={d.name}
                                            className="delta-row clickable"
                                            onClick={() => onSelectCategory?.(d.name)}
                                        >
                                            <span>{d.name}</span>
                                            <strong className={d.delta > 0 ? "expense-amt" : d.delta < 0 ? "income" : ""}>
                                                {d.delta > 0 ? `+${compactMoney(d.delta)}` : d.delta < 0 ? `−${compactMoney(Math.abs(d.delta))}` : "Tetap"}
                                                {d.previous > 0 ? ` (${d.delta > 0 ? "+" : ""}${d.percent_change}%)` : ""}
                                            </strong>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    ) : (
                            <p className="empty">Data siklus sebelumnya belum tersedia.</p>
                        )}
                    </section>

                    <section className="card">
                        <div className="section-title">
                            <h2>Pola pengeluaran per hari</h2>
                            <PieChart size={18} />
                        </div>
                        <div className="dow-chart">
                            {orderedDows.map(dow => {
                                const val = dowTotals[dow];
                                const hPct = Math.round((100 * Math.max(0, val)) / maxDow);
                                const valLabel = val < 0 ? `+${compactMoney(Math.abs(val))}` : val > 0 ? compactMoney(val) : "0";
                                return (
                                    <div key={dow} className="dow-col" title={`${weekdayShort[dow]}: ${money(val)}`}>
                                        <div className="dow-bar-wrap">
                                            <span className="dow-bar" style={{ height: Math.max(4, hPct) + "%" }} />
                                        </div>
                                        <strong>{weekdayShort[dow]}</strong>
                                        <small>{valLabel}</small>
                                    </div>
                                );
                            })}
                        </div>
                    </section>
                </div>
            </div>

            <section className="card">
                <div className="section-title">
                    <div>
                        <h2>Grafik arus kas ({barMode === "daily" ? "Harian" : "Mingguan"})</h2>
                        <small className="muted">
                            {activeBarItem
                                ? `${activeBarItem.fullLabel} · Masuk: +${money(activeBarItem.income)} · Keluar: ${activeBarItem.expense < 0 ? "+" + money(Math.abs(activeBarItem.expense)) : "−" + money(activeBarItem.expense)}`
                                : "Arahkan atau klik batang grafik untuk melihat rincian nominal"}
                        </small>
                    </div>
                    <div className="segmented-pills">
                        <button
                            type="button"
                            className={barMode === "daily" ? "active" : ""}
                            onClick={() => {
                                setBarMode("daily");
                                setSelectedBarIdx(null);
                            }}
                        >
                            Harian
                        </button>
                        <button
                            type="button"
                            className={barMode === "weekly" ? "active" : ""}
                            onClick={() => {
                                setBarMode("weekly");
                                setSelectedBarIdx(null);
                            }}
                        >
                            Mingguan
                        </button>
                    </div>
                </div>

                <div className="cashflow-chart-scroll">
                    <div className={"cashflow-bars " + (barMode === "weekly" ? "weekly" : "daily")}>
                        {activeBars.map((b, i) => {
                            const incH = Math.round((100 * Math.max(0, b.income)) / maxBarValue);
                            const expH = Math.round((100 * Math.max(0, b.expense)) / maxBarValue);
                            return (
                                <div
                                    key={i}
                                    className={"cf-col " + (selectedBarIdx === i ? "selected" : "")}
                                    onMouseEnter={() => setSelectedBarIdx(i)}
                                    onClick={() => setSelectedBarIdx(i)}
                                    title={`${b.fullLabel} · Masuk: ${money(b.income)} · Keluar: ${money(b.expense)}`}
                                >
                                    <div className="cf-pair">
                                        <span
                                            className="cf-bar income-bar"
                                            style={{ height: (b.income > 0 ? Math.max(6, incH) : 0) + "%" }}
                                        />
                                        <span
                                            className="cf-bar expense-bar"
                                            style={{ height: (b.expense > 0 ? Math.max(6, expH) : 0) + "%" }}
                                        />
                                    </div>
                                    <span className="cf-label">{b.label}</span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </section>

            <div className="two-cols">
                <section className="card">
                    <div className="section-title">
                        <h2>Anggaran vs Realisasi</h2>
                    </div>
                    {data.budgets.length ? (
                        <div className="stack">
                            {data.budgets.map(b => (
                                <div
                                    key={b.id}
                                    className="budget-mini-row clickable"
                                    onClick={() => onSelectCategory?.(b.category_name)}
                                >
                                    <div className="category-label">
                                        <strong>{b.category_name}</strong>
                                        <span>
                                            <b className="expense-amt">{money(b.spent)}</b>{" "}
                                            <small className="muted">dari {money(b.amount)}</small>
                                        </span>
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
                                        <small>{b.percent}%</small>
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <p className="empty">Belum ada anggaran kategori yang ditetapkan.</p>
                    )}
                </section>

                <section className="card">
                    <div className="section-title">
                        <h2>Distribusi saldo dompet</h2>
                        <Wallet size={18} />
                    </div>
                    {data.accounts.length ? (
                        <div className="stack">
                            {data.accounts.map((a, i) => {
                                const bal = Math.max(0, a.balance || 0);
                                const pct = totalWallet > 0 ? Math.round((100 * bal) / totalWallet) : 0;
                                return (
                                    <div key={a.id} className="budget-mini-row">
                                        <div className="category-label">
                                            <strong>{a.name}</strong>
                                            <b>{a.balance == null ? "Belum diatur" : money(a.balance)}</b>
                                        </div>
                                        <div className="bar-line">
                                            <span className="bar-track" style={{ height: 7 }}>
                                                <span
                                                    className={"bar bar-" + (i % 5)}
                                                    style={{ width: Math.max(2, pct) + "%" }}
                                                />
                                            </span>
                                            <small>{pct}%</small>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <p className="empty">Belum ada dompet.</p>
                    )}
                </section>
            </div>
        </div>
    );
}
