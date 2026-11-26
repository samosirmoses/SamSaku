"use client";
import { useMemo, useState } from "react";
import {
    ArrowLeftRight,
    Calendar as CalendarIcon,
    Camera,
    ChevronDown,
    ChevronRight,
    Layers,
    List,
    Plus,
    Search,
    X,
} from "lucide-react";
import { TxList } from "../../components/ui";
import {
    type Data,
    type Transaction,
    categoryMatches,
    compactMoney,
    expense,
    fullDate,
    income,
    kindLabels,
    money,
    period,
    shortDate,
    today,
    weekdayShort,
} from "../../lib/domain";

type ViewMode = "daily" | "calendar" | "monthly";

export function TransactionsView({
    data,
    month,
    filter,
    setFilter,
    accountFilter,
    setAccountFilter,
    search,
    setSearch,
    onOpenTx,
    onAddAtDate,
    onScanAtDate,
    onTransferAtDate,
}: {
    data: Data;
    month: string;
    filter: string;
    setFilter: (v: string) => void;
    accountFilter: string;
    setAccountFilter: (v: string) => void;
    search: string;
    setSearch: (v: string) => void;
    onOpenTx: (t: Transaction) => void;
    onAddAtDate: (date: string, kind?: Transaction["kind"]) => void;
    onScanAtDate: (date?: string) => void;
    onTransferAtDate: (date?: string) => void;
}) {
    const [view, setView] = useState<ViewMode>("daily");
    const [kindFilter, setKindFilter] = useState<string>("");

    const startDay = data.settings?.monthly_start_day || 1;
    const weekStart = data.settings?.weekly_start_day ?? 1;
    const range = period(month, startDay);
    const defaultSelectedDate = today() >= range.start && today() <= range.end ? today() : range.start;
    const [selectedDate, setSelectedDate] = useState<string>(defaultSelectedDate);
    const [openWeekIdx, setOpenWeekIdx] = useState<number | null>(0);

    const filteredRows = useMemo(() => {
        const needle = search.trim().toLowerCase();
        return data.transactions.filter(t => {
            if (!categoryMatches(t, filter, data.categories)) return false;
            if (accountFilter && t.account_id !== accountFilter && t.to_account_id !== accountFilter) return false;
            if (kindFilter && t.kind !== kindFilter) return false;
            if (needle) {
                const hay = [t.description, t.account_name, t.to_account_name, t.category_name, t.amount, t.date]
                    .join(" ")
                    .toLowerCase();
                if (!hay.includes(needle)) return false;
            }
            return true;
        });
    }, [data.transactions, data.categories, filter, accountFilter, kindFilter, search]);

    const filteredIncome = filteredRows.reduce((s, t) => s + income(t), 0);
    const filteredExpense = filteredRows.reduce((s, t) => s + expense(t), 0);

    const dailyGroups = useMemo(() => {
        const map = new Map<string, Transaction[]>();
        for (const t of filteredRows) {
            const d = t.date.slice(0, 10);
            const arr = map.get(d) || [];
            arr.push(t);
            map.set(d, arr);
        }
        return Array.from(map.entries())
            .sort((a, b) => b[0].localeCompare(a[0]))
            .map(([date, items]) => ({
                date,
                items,
                inc: items.reduce((s, t) => s + income(t), 0),
                exp: items.reduce((s, t) => s + expense(t), 0),
            }));
    }, [filteredRows]);

    const calendarData = useMemo(() => {
        const startMs = new Date(range.start + "T12:00:00").getTime();
        const endMs = new Date(range.end + "T12:00:00").getTime();
        const totalDays = Math.max(1, Math.round((endMs - startMs) / 86400000) + 1);
        const byDate = new Map<string, { inc: number; exp: number; items: Transaction[] }>();
        let maxDailyExp = 1;
        for (const t of filteredRows) {
            const d = t.date.slice(0, 10);
            const cur = byDate.get(d) || { inc: 0, exp: 0, items: [] };
            cur.inc += income(t);
            cur.exp += Math.max(0, expense(t));
            if (cur.exp > maxDailyExp) maxDailyExp = cur.exp;
            cur.items.push(t);
            byDate.set(d, cur);
        }

        const firstDow = new Date(startMs).getDay();
        const leadingBlanks = (firstDow - weekStart + 7) % 7;
        const cells: (null | {
            date: string;
            dayNum: number;
            monthShort: string;
            inc: number;
            exp: number;
            heatLevel: "none" | "low" | "mid" | "high";
            items: Transaction[];
            isToday: boolean;
        })[] = Array(leadingBlanks).fill(null);

        const todayIso = today();
        for (let i = 0; i < totalDays; i++) {
            const d = new Date(startMs + i * 86400000);
            const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
            const stat = byDate.get(iso) || { inc: 0, exp: 0, items: [] };
            const ratio = stat.exp / maxDailyExp;
            const heatLevel = stat.exp <= 0 ? "none" : ratio > 0.65 ? "high" : ratio > 0.25 ? "mid" : "low";
            cells.push({
                date: iso,
                dayNum: d.getDate(),
                monthShort: d.toLocaleDateString("id-ID", { month: "short" }),
                inc: stat.inc,
                exp: stat.exp,
                heatLevel,
                items: stat.items,
                isToday: iso === todayIso,
            });
        }
        return { cells, byDate };
    }, [range.start, range.end, weekStart, filteredRows]);

    const weeklyGroups = useMemo(() => {
        const startMs = new Date(range.start + "T12:00:00").getTime();
        const endMs = new Date(range.end + "T12:00:00").getTime();
        const totalDays = Math.max(1, Math.round((endMs - startMs) / 86400000) + 1);
        const groups: { startDate: string; endDate: string; inc: number; exp: number; items: Transaction[] }[] = [];
        let current: { startDate: string; endDate: string; inc: number; exp: number; items: Transaction[] } | null =
            null;

        const txByDate = new Map<string, Transaction[]>();
        for (const t of filteredRows) {
            const d = t.date.slice(0, 10);
            const arr = txByDate.get(d) || [];
            arr.push(t);
            txByDate.set(d, arr);
        }

        for (let i = 0; i < totalDays; i++) {
            const d = new Date(startMs + i * 86400000);
            const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
            const dayTxs = txByDate.get(iso) || [];
            const dayInc = dayTxs.reduce((s, t) => s + income(t), 0);
            const dayExp = dayTxs.reduce((s, t) => s + expense(t), 0);

            if (!current || d.getDay() === weekStart) {
                if (current) groups.push(current);
                current = { startDate: iso, endDate: iso, inc: dayInc, exp: dayExp, items: [...dayTxs] };
            } else {
                current.endDate = iso;
                current.inc += dayInc;
                current.exp += dayExp;
                current.items.push(...dayTxs);
            }
        }
        if (current) groups.push(current);
        return groups.reverse();
    }, [range.start, range.end, weekStart, filteredRows]);

    const orderedWeekdayHeaders = Array.from({ length: 7 }, (_, i) => weekdayShort[(weekStart + i) % 7]);
    const activeCalendarDate =
        selectedDate >= range.start && selectedDate <= range.end ? selectedDate : defaultSelectedDate;
    const selectedDayStat = calendarData.byDate.get(activeCalendarDate) || { inc: 0, exp: 0, items: [] };
    const allCategoryNames = [
        ...new Set([...data.categories.map(c => c.name), ...data.summary.categories.map(c => c.name)]),
    ];

    return (
        <div className="stack">
            <section className="card">
                <div className="tx-toolbar">
                    <div className="view-switcher" role="tablist" aria-label="Mode tampilan transaksi">
                        <button
                            type="button"
                            role="tab"
                            aria-selected={view === "daily"}
                            className={view === "daily" ? "active" : ""}
                            onClick={() => setView("daily")}
                        >
                            <List size={16} /> Harian
                        </button>
                        <button
                            type="button"
                            role="tab"
                            aria-selected={view === "calendar"}
                            className={view === "calendar" ? "active" : ""}
                            onClick={() => setView("calendar")}
                        >
                            <CalendarIcon size={16} /> Kalender
                        </button>
                        <button
                            type="button"
                            role="tab"
                            aria-selected={view === "monthly"}
                            className={view === "monthly" ? "active" : ""}
                            onClick={() => setView("monthly")}
                        >
                            <Layers size={16} /> Mingguan & Bulanan
                        </button>
                    </div>

                    <div className="btns">
                        <button
                            type="button"
                            className="btn"
                            onClick={() => onScanAtDate(view === "calendar" ? activeCalendarDate : undefined)}
                        >
                            <Camera size={16} /> Foto struk
                        </button>
                        {data.accounts.length >= 2 && (
                            <button
                                type="button"
                                className="btn"
                                onClick={() => onTransferAtDate(view === "calendar" ? activeCalendarDate : undefined)}
                            >
                                <ArrowLeftRight size={16} /> Transfer
                            </button>
                        )}
                        <button
                            type="button"
                            className="btn primary"
                            onClick={() => onAddAtDate(view === "calendar" ? activeCalendarDate : today())}
                        >
                            <Plus size={16} /> Catat transaksi
                        </button>
                    </div>
                </div>

                <div className="filter-stack">
                    <div className="filter-bar" style={{ marginBottom: 0 }}>
                        <label className="search">
                            <Search size={17} />
                            <input
                                placeholder="Cari transaksi, toko, dompet, atau nominal…"
                                aria-label="Cari transaksi"
                                value={search}
                                onChange={e => setSearch(e.target.value)}
                            />
                            {search && (
                                <button
                                    type="button"
                                    className="icon-btn"
                                    style={{ width: 28, height: 28, minHeight: 28 }}
                                    onClick={() => setSearch("")}
                                >
                                    <X size={14} />
                                </button>
                            )}
                        </label>
                        <select aria-label="Filter kategori" value={filter} onChange={e => setFilter(e.target.value)}>
                            <option value="">Semua kategori</option>
                            {allCategoryNames.map(c => (
                                <option key={c} value={c}>
                                    {c}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className="quick-filter-pills">
                        <button
                            type="button"
                            className={"filter-pill " + (!accountFilter ? "active" : "")}
                            onClick={() => setAccountFilter("")}
                        >
                            Semua Dompet
                        </button>
                        {data.accounts.map(a => (
                            <button
                                type="button"
                                key={a.id}
                                className={"filter-pill " + (accountFilter === a.id ? "active" : "")}
                                onClick={() => setAccountFilter(accountFilter === a.id ? "" : a.id)}
                            >
                                {a.name}
                            </button>
                        ))}
                        <span className="pill-divider" />
                        {(["", "expense", "income", "transfer"] as const).map(k => (
                            <button
                                type="button"
                                key={k || "all"}
                                className={`filter-pill ${k} ${kindFilter === k ? "active" : ""}`}
                                onClick={() => setKindFilter(kindFilter === k ? "" : k)}
                            >
                                {k ? kindLabels[k] : "Semua Jenis"}
                            </button>
                        ))}
                        {filter && (
                            <button type="button" className="filter-pill active" onClick={() => setFilter("")}>
                                Kategori: {filter} <X size={12} />
                            </button>
                        )}
                    </div>
                </div>

                <div className="tx-summary-strip">
                    <span>
                        <b>{filteredRows.length}</b> transaksi
                    </span>
                    <span>
                        Uang Masuk: <strong className="income">+{money(filteredIncome)}</strong>
                    </span>
                    <span>
                        Uang Keluar: <strong className="expense-amt">−{money(filteredExpense)}</strong>
                    </span>
                    <span>
                        Selisih:{" "}
                        <strong className={filteredIncome - filteredExpense >= 0 ? "income" : "expense-amt"}>
                            {filteredIncome - filteredExpense > 0 ? "+" : ""}
                            {money(filteredIncome - filteredExpense)}
                        </strong>
                    </span>
                </div>
            </section>

            {view === "daily" && (
                <div className="stack">
                    {dailyGroups.length ? (
                        dailyGroups.map(group => (
                            <section key={group.date} className="card daily-group-card">
                                <div className="daily-header">
                                    <div>
                                        <strong>{fullDate(group.date)}</strong>
                                        <small className="muted">{group.items.length} transaksi</small>
                                    </div>
                                    <div className="daily-header-right">
                                        {group.inc > 0 && (
                                            <span className="daily-pill income">+{money(group.inc)}</span>
                                        )}
                                        {group.exp > 0 && (
                                            <span className="daily-pill expense-amt">−{money(group.exp)}</span>
                                        )}
                                        <button
                                            type="button"
                                            className="btn sm"
                                            title={`Catat transaksi pada ${group.date}`}
                                            onClick={() => onAddAtDate(group.date)}
                                        >
                                            <Plus size={14} /> Catat
                                        </button>
                                    </div>
                                </div>
                                <TxList rows={group.items} accounts={data.accounts} open={onOpenTx} showDate={false} />
                            </section>
                        ))
                    ) : (
                        <section className="card">
                            <p className="empty">Belum ada transaksi untuk filter ini.</p>
                        </section>
                    )}
                </div>
            )}

            {view === "calendar" && (
                <div className="calendar-layout">
                    <section className="card">
                        <div className="calendar-weekdays">
                            {orderedWeekdayHeaders.map(w => (
                                <div key={w} className="calendar-weekday">
                                    {w}
                                </div>
                            ))}
                        </div>
                        <div className="calendar-grid">
                            {calendarData.cells.map((cell, idx) =>
                                cell ? (
                                    <button
                                        type="button"
                                        key={cell.date}
                                        className={
                                            `calendar-cell heat-${cell.heatLevel} ` +
                                            (cell.date === activeCalendarDate ? "selected " : "") +
                                            (cell.isToday ? "today " : "")
                                        }
                                        onClick={() => setSelectedDate(cell.date)}
                                    >
                                        <span className="cal-day-num">
                                            {cell.dayNum}
                                            {cell.dayNum === 1 ? ` ${cell.monthShort}` : ""}
                                        </span>
                                        <span className="cal-amounts">
                                            {cell.inc > 0 && (
                                                <small className="cal-inc">+{compactMoney(cell.inc)}</small>
                                            )}
                                            {cell.exp > 0 && (
                                                <small className="cal-exp">−{compactMoney(cell.exp)}</small>
                                            )}
                                        </span>
                                    </button>
                                ) : (
                                    <div key={"blank-" + idx} className="calendar-cell blank" />
                                )
                            )}
                        </div>
                    </section>

                    <section className="card calendar-side">
                        <div className="section-title">
                            <div>
                                <h2>{fullDate(activeCalendarDate)}</h2>
                                <small className="muted">
                                    Masuk: <b className="income">+{money(selectedDayStat.inc)}</b> · Keluar:{" "}
                                    <b className="expense-amt">−{money(selectedDayStat.exp)}</b>
                                </small>
                            </div>
                        </div>
                        <div className="btns" style={{ marginBottom: 14 }}>
                            <button
                                type="button"
                                className="btn primary sm"
                                onClick={() => onAddAtDate(activeCalendarDate, "expense")}
                            >
                                <Plus size={14} /> Pengeluaran
                            </button>
                            <button
                                type="button"
                                className="btn sm"
                                onClick={() => onAddAtDate(activeCalendarDate, "income")}
                            >
                                <Plus size={14} /> Pemasukan
                            </button>
                            <button
                                type="button"
                                className="btn sm"
                                onClick={() => onScanAtDate(activeCalendarDate)}
                            >
                                <Camera size={14} /> Struk
                            </button>
                            {data.accounts.length >= 2 && (
                                <button
                                    type="button"
                                    className="btn sm"
                                    onClick={() => onTransferAtDate(activeCalendarDate)}
                                >
                                    <ArrowLeftRight size={14} /> Transfer
                                </button>
                            )}
                        </div>
                        {selectedDayStat.items.length ? (
                            <TxList
                                rows={selectedDayStat.items}
                                accounts={data.accounts}
                                open={onOpenTx}
                                showDate={false}
                            />
                        ) : (
                            <p className="empty">
                                Tidak ada transaksi pada tanggal ini. Klik tombol di atas untuk mencatat transaksi
                                langsung di tanggal {shortDate(activeCalendarDate)}.
                            </p>
                        )}
                    </section>
                </div>
            )}

            {view === "monthly" && (
                <div className="stack">
                    <section className="card">
                        <div className="section-title">
                            <div>
                                <h2>
                                    Rekap siklus ({shortDate(range.start)} – {shortDate(range.end)})
                                </h2>
                                <small className="muted">{filteredRows.length} transaksi dalam siklus ini</small>
                            </div>
                            <button
                                type="button"
                                className="btn primary sm"
                                onClick={() => onAddAtDate(defaultSelectedDate)}
                            >
                                <Plus size={14} /> Catat di siklus ini
                            </button>
                        </div>
                        <div className="monthly-kpi-row">
                            <div>
                                <small className="muted">Total Uang Masuk</small>
                                <strong className="income">+{money(filteredIncome)}</strong>
                            </div>
                            <div>
                                <small className="muted">Total Uang Keluar</small>
                                <strong className="expense-amt">−{money(filteredExpense)}</strong>
                            </div>
                            <div>
                                <small className="muted">Selisih Bersih</small>
                                <strong className={filteredIncome - filteredExpense >= 0 ? "income" : "expense-amt"}>
                                    {filteredIncome - filteredExpense > 0 ? "+" : ""}
                                    {money(filteredIncome - filteredExpense)}
                                </strong>
                            </div>
                        </div>
                    </section>

                    {weeklyGroups.map((w, idx) => {
                        const isOpen = openWeekIdx === idx;
                        const net = w.inc - w.exp;
                        return (
                            <section key={w.startDate} className="card">
                                <div className="weekly-header">
                                    <button
                                        type="button"
                                        className="weekly-toggle"
                                        onClick={() => setOpenWeekIdx(isOpen ? null : idx)}
                                    >
                                        {isOpen ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                                        <div>
                                            <strong>
                                                Minggu {weeklyGroups.length - idx} ({shortDate(w.startDate)} –{" "}
                                                {shortDate(w.endDate)})
                                            </strong>
                                            <small className="muted">{w.items.length} transaksi</small>
                                        </div>
                                    </button>
                                    <div className="daily-header-right">
                                        <span className="daily-pill income">+{money(w.inc)}</span>
                                        <span className="daily-pill expense-amt">−{money(w.exp)}</span>
                                        <span className={"daily-pill " + (net >= 0 ? "income" : "expense-amt")}>
                                            Net {net > 0 ? "+" : ""}
                                            {money(net)}
                                        </span>
                                        <button
                                            type="button"
                                            className="btn sm"
                                            onClick={() =>
                                                onAddAtDate(w.endDate <= today() ? w.endDate : w.startDate)
                                            }
                                        >
                                            <Plus size={14} /> Catat
                                        </button>
                                    </div>
                                </div>
                                {isOpen && (
                                    <div style={{ marginTop: 12 }}>
                                        <TxList rows={w.items} accounts={data.accounts} open={onOpenTx} />
                                    </div>
                                )}
                            </section>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
