"use client";
import {
    ArrowLeftRight,
    CalendarDays,
    Camera,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    Inbox,
    LogIn,
    LogOut,
    Menu,
    Moon,
    Plus,
    RefreshCw,
    Settings as SettingsIcon,
    Sun,
    X,
} from "lucide-react";
import type { ThemeMode } from "../../hooks/useTheme";
import { type Transaction, cycleMonthForDate, monthLabel, periodRangeLabel, shiftMonth, today } from "../../lib/domain";
import { NAV_LINKS, PAGE_LABELS, type Page } from "./navigation";

export function SidebarNav({
    page,
    authed,
    reviewCount = 0,
    onNav,
    onAuthAction,
}: {
    page: Page;
    authed: boolean;
    reviewCount?: number;
    onNav: (p: Page) => void;
    onAuthAction: () => void;
}) {
    return (
        <>
            <div className="brand">
                <img src="/icon.svg" alt="" width="34" height="34" />
                <span>SamSaku</span>
            </div>
            <nav aria-label="Menu utama" className="side-links">
                {NAV_LINKS.map(({ page: p, icon: Icon }, i) => (
                    <button
                        key={p}
                        className={(page === p ? "active " : "") + (i === 5 ? "section-break" : "")}
                        aria-current={page === p ? "page" : undefined}
                        onClick={() => onNav(p)}
                    >
                        <Icon size={18} strokeWidth={1.8} />
                        <span className="side-link-label">{PAGE_LABELS[p]}</span>
                        {p === "reviews" && reviewCount > 0 && <span className="nav-badge">{reviewCount}</span>}
                    </button>
                ))}
            </nav>
            <div className="sidebar-footer">
                <button onClick={onAuthAction}>
                    {authed ? <LogOut size={17} /> : <LogIn size={17} />}{" "}
                    {authed ? "Keluar dari server" : "Hubungkan server"}
                </button>
            </div>
        </>
    );
}

export function Topbar({
    page,
    theme,
    ready,
    demoMode,
    live,
    refreshing = false,
    reviewCount = 0,
    onOpenMenu,
    onToggleTheme,
    onOpenSettings,
    onOpenReviews,
    onOpenLogin,
}: {
    page: Page;
    theme: ThemeMode;
    ready: boolean;
    demoMode: boolean;
    live: boolean;
    refreshing?: boolean;
    reviewCount?: number;
    onOpenMenu: () => void;
    onToggleTheme: (next: ThemeMode) => void;
    onOpenSettings: () => void;
    onOpenReviews?: () => void;
    onOpenLogin: () => void;
}) {
    return (
        <header className="topbar">
            <div className="crumb">
                <button className="icon-btn mobile-menu" aria-label="Buka navigasi" onClick={onOpenMenu}>
                    <Menu size={21} />
                </button>
                <span className="desktop-crumb">SamSaku</span>
                <ChevronRight className="desktop-crumb" size={13} />
                <strong>{PAGE_LABELS[page]}</strong>
                {refreshing && (
                    <span className="syncing-pill" aria-live="polite">
                        <RefreshCw size={12} className="spin-icon" /> Sinkron…
                    </span>
                )}
            </div>
            <div className="top-actions">
                {reviewCount > 0 && onOpenReviews && page !== "reviews" && (
                    <button
                        type="button"
                        className="review-top-pill"
                        title="Ada bukti/draf baru menunggu keputusan"
                        onClick={onOpenReviews}
                    >
                        <Inbox size={14} />
                        <span>{reviewCount} Draf</span>
                    </button>
                )}
                <button
                    type="button"
                    className="icon-btn"
                    title={theme === "dark" ? "Ganti ke Mode Terang" : "Ganti ke Mode Gelap"}
                    aria-label="Ganti tema tampilan"
                    onClick={() => onToggleTheme(theme === "dark" ? "light" : "dark")}
                >
                    {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
                </button>
                <button
                    type="button"
                    className="icon-btn"
                    title="Pengaturan siklus & aplikasi"
                    onClick={onOpenSettings}
                >
                    <SettingsIcon size={18} />
                </button>
                {ready && (
                    <button onClick={onOpenLogin} className="account-badge">
                        <span className={"dot " + (!demoMode ? (live ? "online live" : "online") : "")} />
                        {demoMode ? "Sandbox" : live ? "Live" : "Terhubung"}
                    </button>
                )}
            </div>
        </header>
    );
}

export function CyclePickerControl({
    month,
    startDay,
    onPickMonth,
}: {
    month: string;
    startDay: number;
    onPickMonth: (m: string) => void;
}) {
    const currentCycleMonth = cycleMonthForDate(today(), startDay);
    const isCurrentMonth = month === currentCycleMonth;

    return (
        <div className="cycle-picker">
            <button
                type="button"
                className="icon-btn cycle-arrow"
                aria-label="Periode sebelumnya"
                onClick={() => onPickMonth(shiftMonth(month, -1))}
            >
                <ChevronLeft size={17} />
            </button>
            <label className="month-btn">
                <CalendarDays size={15} />
                <span>{monthLabel(month)}</span>
                <ChevronDown size={13} />
                <input
                    aria-label="Bulan tampilan"
                    type="month"
                    value={month}
                    onChange={e => e.target.value && onPickMonth(e.target.value)}
                />
            </label>
            <button
                type="button"
                className="icon-btn cycle-arrow"
                aria-label="Periode berikutnya"
                onClick={() => onPickMonth(shiftMonth(month, 1))}
            >
                <ChevronRight size={17} />
            </button>
            {!isCurrentMonth && (
                <button
                    type="button"
                    className="btn sm cycle-today-btn"
                    onClick={() => onPickMonth(currentCycleMonth)}
                >
                    Hari Ini
                </button>
            )}
        </div>
    );
}

export function PageHeader({
    page,
    month,
    startDay,
    onPickMonth,
    onScanReceipt,
    onNewEntry,
}: {
    page: Page;
    month: string;
    startDay: number;
    onPickMonth: (m: string) => void;
    onScanReceipt: () => void;
    onNewEntry: () => void;
}) {
    // On "transactions", the cycle picker lives directly inside the unified Transactions toolbar for better focus.
    const showCyclePicker = ["home", "budgets", "stats"].includes(page) && !!month;
    return (
        <div className={"page-heading" + (page === "transactions" ? " compact" : "")}>
            <div>
                <h1>{page === "home" ? "Ringkasan Keuangan" : PAGE_LABELS[page]}</h1>
                {(showCyclePicker || page === "transactions") && month && (
                    <p>
                        Siklus aktif: <b>{periodRangeLabel(month, startDay)}</b>
                        {startDay !== 1 ? ` (Mulai tgl ${startDay})` : ""}
                    </p>
                )}
            </div>
            <div className="heading-actions">
                {showCyclePicker && (
                    <CyclePickerControl month={month} startDay={startDay} onPickMonth={onPickMonth} />
                )}
                {["home", "transactions"].includes(page) && (
                    <>
                        <button className="btn desktop-only-action" onClick={onScanReceipt}>
                            <Camera size={16} /> Foto struk
                        </button>
                        <button className="btn primary desktop-only-action" onClick={onNewEntry}>
                            <Plus size={16} /> Catat transaksi
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}

export function BottomNav({
    page,
    reviewCount = 0,
    onNav,
    onNewEntry,
    onOpenMenu,
}: {
    page: Page;
    reviewCount?: number;
    onNav: (p: Page) => void;
    onNewEntry: () => void;
    onOpenMenu: () => void;
}) {
    const HomeIcon = NAV_LINKS[0].icon;
    const TxIcon = NAV_LINKS[1].icon;
    const BudgetIcon = NAV_LINKS[2].icon;

    return (
        <nav className="bottom-nav" aria-label="Navigasi bawah">
            <button
                aria-current={page === "home" ? "page" : undefined}
                className={page === "home" ? "active" : ""}
                onClick={() => onNav("home")}
            >
                <HomeIcon size={19} />
                <span>Ringkasan</span>
            </button>
            <button
                aria-current={page === "transactions" ? "page" : undefined}
                className={page === "transactions" ? "active" : ""}
                onClick={() => onNav("transactions")}
            >
                <TxIcon size={19} />
                <span>Transaksi</span>
            </button>
            <button
                type="button"
                className="bottom-nav-add"
                aria-label="Catat transaksi baru"
                onClick={onNewEntry}
            >
                <span className="bottom-nav-add-circle">
                    <Plus size={22} strokeWidth={2.5} />
                </span>
                <span>Catat</span>
            </button>
            <button
                aria-current={page === "budgets" ? "page" : undefined}
                className={page === "budgets" ? "active" : ""}
                onClick={() => onNav("budgets")}
            >
                <BudgetIcon size={19} />
                <span>Anggaran</span>
            </button>
            <button
                onClick={onOpenMenu}
                aria-label="Menu lainnya"
                className={["stats", "reviews", "reports", "import", "masters", "settings"].includes(page) ? "active" : ""}
            >
                <span className="bottom-nav-icon-wrap">
                    <Menu size={19} />
                    {reviewCount > 0 && <span className="bottom-nav-dot">{reviewCount}</span>}
                </span>
                <span>Menu</span>
            </button>
        </nav>
    );
}

export function QuickFab({
    open,
    canTransfer,
    onToggle,
    onOpenEntry,
}: {
    open: boolean;
    canTransfer: boolean;
    onToggle: () => void;
    onOpenEntry: (opts: { kind?: Transaction["kind"]; autoScan?: boolean }) => void;
}) {
    return (
        <div className="fab-container desktop-fab">
            {open && (
                <div className="fab-menu">
                    <button
                        type="button"
                        className="fab-action"
                        onClick={() => onOpenEntry({ kind: "expense", autoScan: true })}
                    >
                        <Camera size={16} /> Foto Struk (Auto-Fill)
                    </button>
                    {canTransfer && (
                        <button
                            type="button"
                            className="fab-action"
                            onClick={() => onOpenEntry({ kind: "transfer" })}
                        >
                            <ArrowLeftRight size={16} /> Transfer Antar Dompet
                        </button>
                    )}
                    <button type="button" className="fab-action" onClick={() => onOpenEntry({ kind: "income" })}>
                        <Plus size={16} /> Catat Pemasukan
                    </button>
                    <button
                        type="button"
                        className="fab-action primary"
                        onClick={() => onOpenEntry({ kind: "expense" })}
                    >
                        <Plus size={16} /> Catat Pengeluaran
                    </button>
                </div>
            )}
            <button
                type="button"
                className={"fab-main " + (open ? "open" : "")}
                aria-label="Aksi cepat transaksi"
                onClick={onToggle}
            >
                {open ? <X size={22} /> : <Plus size={22} />}
            </button>
        </div>
    );
}
