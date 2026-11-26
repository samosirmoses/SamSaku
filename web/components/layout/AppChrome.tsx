"use client";
import {
    ArrowLeftRight,
    BarChart3,
    CalendarDays,
    Camera,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    LogIn,
    LogOut,
    Menu,
    Moon,
    Plus,
    Settings as SettingsIcon,
    Sun,
    X,
} from "lucide-react";
import type { ThemeMode } from "../../hooks/useTheme";
import { type Transaction, monthLabel, periodRangeLabel, shiftMonth } from "../../lib/domain";
import { NAV_LINKS, PAGE_LABELS, type Page } from "./navigation";

export function SidebarNav({
    page,
    authed,
    onNav,
    onAuthAction,
}: {
    page: Page;
    authed: boolean;
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
                        className={(page === p ? "active " : "") + (i === 4 ? "section-break" : "")}
                        aria-current={page === p ? "page" : undefined}
                        onClick={() => onNav(p)}
                    >
                        <Icon size={18} strokeWidth={1.8} />
                        {PAGE_LABELS[p]}
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
    onOpenMenu,
    onToggleTheme,
    onOpenSettings,
    onOpenLogin,
}: {
    page: Page;
    theme: ThemeMode;
    ready: boolean;
    demoMode: boolean;
    live: boolean;
    onOpenMenu: () => void;
    onToggleTheme: (next: ThemeMode) => void;
    onOpenSettings: () => void;
    onOpenLogin: () => void;
}) {
    return (
        <header className="topbar">
            <div className="crumb">
                <button className="icon-btn mobile-menu" aria-label="Buka navigasi" onClick={onOpenMenu}>
                    <Menu size={21} />
                </button>
                <span className="desktop-crumb">SamSaku Wealth</span>
                <ChevronRight className="desktop-crumb" size={13} />
                <strong>{PAGE_LABELS[page]}</strong>
            </div>
            <div className="top-actions">
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
                <span className="avatar" aria-hidden="true">
                    S
                </span>
            </div>
        </header>
    );
}

export function PageHeader({
    page,
    month,
    startDay,
    onPickMonth,
    onOpenStats,
    onNewEntry,
}: {
    page: Page;
    month: string;
    startDay: number;
    onPickMonth: (m: string) => void;
    onOpenStats: () => void;
    onNewEntry: () => void;
}) {
    const showCyclePicker = ["home", "transactions", "budgets", "stats"].includes(page) && !!month;
    return (
        <div className="page-heading">
            <div>
                <h1>{page === "home" ? "Ringkasan Keuangan" : PAGE_LABELS[page]}</h1>
                {showCyclePicker && (
                    <p>
                        Siklus aktif: <b>{periodRangeLabel(month, startDay)}</b>
                        {startDay !== 1 ? ` (Mulai tgl ${startDay})` : ""}
                    </p>
                )}
            </div>
            <div className="heading-actions">
                {showCyclePicker && (
                    <div className="cycle-picker">
                        <button
                            type="button"
                            className="icon-btn"
                            aria-label="Periode sebelumnya"
                            onClick={() => onPickMonth(shiftMonth(month, -1))}
                        >
                            <ChevronLeft size={17} />
                        </button>
                        <label className="month-btn">
                            <CalendarDays size={16} />
                            <span>{monthLabel(month)}</span>
                            <ChevronDown size={14} />
                            <input
                                aria-label="Bulan tampilan"
                                type="month"
                                value={month}
                                onChange={e => e.target.value && onPickMonth(e.target.value)}
                            />
                        </label>
                        <button
                            type="button"
                            className="icon-btn"
                            aria-label="Periode berikutnya"
                            onClick={() => onPickMonth(shiftMonth(month, 1))}
                        >
                            <ChevronRight size={17} />
                        </button>
                    </div>
                )}
                {page === "home" && (
                    <>
                        <button className="btn desktop-only-action" onClick={onOpenStats}>
                            <BarChart3 size={16} /> Statistik
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
    onNav,
    onOpenMenu,
}: {
    page: Page;
    onNav: (p: Page) => void;
    onOpenMenu: () => void;
}) {
    return (
        <nav className="bottom-nav" aria-label="Navigasi bawah">
            {NAV_LINKS.slice(0, 4).map(({ page: p, icon: Icon }) => (
                <button
                    aria-current={page === p ? "page" : undefined}
                    key={p}
                    className={page === p ? "active" : ""}
                    onClick={() => onNav(p)}
                >
                    <Icon size={19} />
                    {PAGE_LABELS[p]}
                </button>
            ))}
            <button onClick={onOpenMenu} aria-label="Menu lainnya">
                <Menu size={19} />
                Lainnya
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
        <div className="fab-container">
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
