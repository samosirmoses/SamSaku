"use client";
import { useEffect, useRef, useState } from "react";
import {
    ArrowLeftRight,
    BarChart3,
    CalendarDays,
    Camera,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    Database,
    FileChartColumnIncreasing,
    FileSpreadsheet,
    Home,
    Inbox,
    LogIn,
    LogOut,
    Menu,
    Moon,
    Pencil,
    Plus,
    ReceiptText,
    Settings as SettingsIcon,
    Sun,
    Trash2,
    Wallet,
    X,
} from "lucide-react";
import { allowDev, del, get, getAuthCredentials, getSavedToken, post, setSavedToken, supabase, wsEndpoint } from "../lib/api";
import {
    type Account,
    type Budget,
    type Data,
    type Review,
    type Settings,
    type Transaction,
    cycleMonthForDate,
    kindLabels,
    monthLabel,
    money,
    period,
    periodRangeLabel,
    shiftMonth,
    today,
} from "../lib/domain";
import { Dashboard, Accounts } from "../components/Dashboard";
import { Field, Modal, ErrorNote } from "../components/ui";
import { CategoryEdit } from "../components/CategoryEdit";
import { EntryForm, MasterForm } from "../components/Entries";
import { BudgetsView } from "../components/Planning";
import { Importer } from "../components/Importer";
import { Reports } from "../components/Reports";
import { Statistics } from "../components/Statistics";
import { SettingsView } from "../components/SettingsView";
import { TransactionsView } from "../components/TransactionsView";

type Page =
    | "home"
    | "transactions"
    | "budgets"
    | "stats"
    | "reports"
    | "import"
    | "masters"
    | "settings"
    | "reviews";

const labels: Record<Page, string> = {
    home: "Ringkasan",
    transactions: "Transaksi",
    budgets: "Anggaran",
    stats: "Statistik",
    reports: "Laporan",
    import: "Impor Excel",
    masters: "Master data",
    settings: "Pengaturan",
    reviews: "Perlu ditinjau",
};

const links = [
    { page: "home", icon: Home },
    { page: "transactions", icon: ReceiptText },
    { page: "budgets", icon: Wallet },
    { page: "stats", icon: BarChart3 },
    { page: "reports", icon: FileChartColumnIncreasing },
    { page: "import", icon: FileSpreadsheet },
    { page: "masters", icon: Database },
    { page: "settings", icon: SettingsIcon },
] as const;

type Dialog =
    | "login"
    | "entry"
    | "edit-entry"
    | "account"
    | "edit-account"
    | "category"
    | "edit-category"
    | "detail"
    | "review"
    | "receipt"
    | null;

export default function Page() {
    const [month, setMonth] = useState("");
    const [page, setPage] = useState<Page>("home");
    const [data, setData] = useState<Data | null>(null);
    const [demoMode, setDemoMode] = useState(true);
    const [authed, setAuthed] = useState(false);
    const [ready, setReady] = useState(false);
    const [refresh, setRefresh] = useState(0);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);
    const [theme, setTheme] = useState<"light" | "dark">("light");
    const [fabOpen, setFabOpen] = useState(false);

    const [dialog, setDialog] = useState<Dialog>(null);
    const [menu, setMenu] = useState(false);
    const [filter, setFilter] = useState("");
    const [accountFilter, setAccountFilter] = useState("");
    const [search, setSearch] = useState("");
    const [doc, setDoc] = useState<Transaction | null>(null);
    const [rev, setRev] = useState<Review | null>(null);
    const [notice, setNotice] = useState("");
    const [selectedCategory, setSelectedCategory] = useState<Data["categories"][number] | null>(null);
    const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);
    const [entryPreset, setEntryPreset] = useState<{
        date?: string;
        kind?: Transaction["kind"];
        account_id?: string;
        autoScan?: boolean;
    }>({});
    const [confirmDeleteTx, setConfirmDeleteTx] = useState(false);
    const [deletingTx, setDeletingTx] = useState(false);
    const [live, setLive] = useState(false);

    const main = useRef<HTMLElement>(null);
    const loadedMonth = useRef("");
    const userPickedMonth = useRef(false);
    const silentRefresh = useRef(false);

    function applyTheme(next: "light" | "dark") {
        setTheme(next);
        if (typeof document !== "undefined") {
            document.documentElement.setAttribute("data-theme", next);
            try {
                localStorage.setItem("samsaku-theme", next);
            } catch {}
        }
    }

    useEffect(() => {
        setMonth(today().slice(0, 7));
        try {
            const savedTheme = localStorage.getItem("samsaku-theme");
            if (savedTheme === "dark" || savedTheme === "light") {
                applyTheme(savedTheme);
            }
        } catch {}

        const sb = supabase();
        let alive = true;
        const listen = sb?.auth.onAuthStateChange((_ev, session) => {
            if (alive) {
                const ok = !!session || (allowDev() && !!getSavedToken());
                setAuthed(ok);
                setDemoMode(!ok);
                setReady(true);
            }
        });
        if (!sb) {
            const ok = allowDev() && !!getSavedToken();
            setAuthed(ok);
            setDemoMode(!ok);
            setReady(true);
        }
        if ("serviceWorker" in navigator && process.env.NODE_ENV === "production")
            navigator.serviceWorker.register("/sw.js").catch(() => {});
        return () => {
            alive = false;
            listen?.data.subscription.unsubscribe();
        };
    }, []);

    useEffect(() => {
        if (!month || !ready) return;
        let valid = true;
        const isSilent = silentRefresh.current && loadedMonth.current === month;
        silentRefresh.current = false;
        setError("");
        if (!isSilent) {
            if (loadedMonth.current !== month) setData(null);
            setLoading(true);
        }

        get<Settings>("/settings")
            .catch(() => ({ monthly_start_day: 1, weekly_start_day: 1, default_account_id: null }))
            .then(settings => {
                const startDay = settings.monthly_start_day || 1;
                const activeCycleMonth = cycleMonthForDate(today(), startDay);
                if (!userPickedMonth.current && activeCycleMonth !== month) {
                    if (valid) setMonth(activeCycleMonth);
                    return null;
                }
                const range = period(month, startDay);
                const q = "?" + new URLSearchParams(range);
                return Promise.all([
                    Promise.resolve(settings),
                    get<Data["accounts"]>("/accounts"),
                    get<Data["categories"]>("/categories"),
                    get<Data["reviews"]>("/reviews"),
                    get<Budget[]>("/budgets" + q),
                    get<Data["summary"]>("/summary" + q),
                    get<Data["connections"]>("/connections"),
                ]);
            })
            .then(res => {
                if (!res || !valid) return;
                const [settings, accounts, categories, reviews, budgets, summary, connections] = res;
                loadedMonth.current = month;
                setData({
                    accounts,
                    categories,
                    transactions: summary.transactions,
                    reviews,
                    budgets: summary.budgets || budgets,
                    settings,
                    summary,
                    connections,
                });
            })
            .catch(e => {
                if (valid && !isSilent) setError(e.message);
            })
            .finally(() => {
                if (valid && !isSilent) setLoading(false);
            });
        return () => {
            valid = false;
        };
    }, [month, ready, demoMode, refresh]);

    useEffect(() => {
        if (!ready || !authed || demoMode) {
            setLive(false);
            return;
        }
        const url = wsEndpoint();
        if (!url) return;
        let active = true;
        let ws: WebSocket | null = null;
        let retryDelay = 2000;
        let retryTimer: ReturnType<typeof setTimeout> | null = null;
        let pingTimer: ReturnType<typeof setInterval> | null = null;

        const triggerSilentRefresh = (msg?: string) => {
            silentRefresh.current = true;
            setRefresh(v => v + 1);
            if (msg) setNotice(msg);
        };

        const connect = async () => {
            if (!active) return;
            const creds = await getAuthCredentials();
            if (!active || !creds) return;
            try {
                ws = new WebSocket(url);
            } catch {
                scheduleReconnect();
                return;
            }
            ws.onopen = () => {
                if (!active || !ws) return;
                ws.send(JSON.stringify({ type: "auth", ...creds }));
            };
            ws.onmessage = ev => {
                if (!active) return;
                try {
                    const msg = JSON.parse(String(ev.data || "{}"));
                    if (msg.type === "connected") {
                        setLive(true);
                        retryDelay = 2000;
                        if (pingTimer) clearInterval(pingTimer);
                        pingTimer = setInterval(() => {
                            if (ws && ws.readyState === WebSocket.OPEN) {
                                ws.send(JSON.stringify({ type: "ping" }));
                            }
                        }, 25000);
                    } else if (msg.type === "ping") {
                        ws?.send(JSON.stringify({ type: "pong" }));
                    } else if (msg.type === "sync") {
                        const toastMsg =
                            typeof msg.message === "string" && msg.message.trim() ? msg.message.trim() : undefined;
                        triggerSilentRefresh(toastMsg);
                    }
                } catch {}
            };
            ws.onclose = () => {
                if (!active) return;
                setLive(false);
                if (pingTimer) {
                    clearInterval(pingTimer);
                    pingTimer = null;
                }
                scheduleReconnect();
            };
            ws.onerror = () => {
                ws?.close();
            };
        };

        const scheduleReconnect = () => {
            if (!active || retryTimer) return;
            retryTimer = setTimeout(() => {
                retryTimer = null;
                retryDelay = Math.min(retryDelay * 1.5, 15000);
                connect();
            }, retryDelay);
        };

        const onVisible = () => {
            if (document.visibilityState === "visible") {
                triggerSilentRefresh();
                if (!ws || ws.readyState === WebSocket.CLOSED) connect();
            }
        };

        connect();
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            active = false;
            setLive(false);
            document.removeEventListener("visibilitychange", onVisible);
            if (retryTimer) clearTimeout(retryTimer);
            if (pingTimer) clearInterval(pingTimer);
            ws?.close();
        };
    }, [ready, authed, demoMode]);

    useEffect(() => {
        if (!notice) return;
        const timer = setTimeout(() => setNotice(""), 4000);
        return () => clearTimeout(timer);
    }, [notice]);

    function nav(p: Page) {
        setPage(p);
        setMenu(false);
        setFabOpen(false);
        setFilter("");
        setAccountFilter("");
        setSearch("");
        window.scrollTo({ top: 0 });
    }

    function write(d: Dialog) {
        setFabOpen(false);
        setDialog(d);
    }

    function openEntry(
        opts: {
            date?: string;
            kind?: Transaction["kind"];
            account_id?: string;
            autoScan?: boolean;
        } = {}
    ) {
        setFabOpen(false);
        setEntryPreset(opts);
        setDialog(opts.autoScan ? "receipt" : "entry");
    }

    function done() {
        setDialog(null);
        setDoc(null);
        setSelectedAccount(null);
        setSelectedCategory(null);
        setConfirmDeleteTx(false);
        setRefresh(v => v + 1);
        setNotice("Perubahan tersimpan.");
    }

    const detail = (t: Transaction) => {
        setDoc(t);
        setConfirmDeleteTx(false);
        setDialog("detail");
    };

    async function deleteCurrentTx() {
        if (!doc) return;
        setDeletingTx(true);
        try {
            await del("/transactions/" + doc.id);
            done();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Gagal menghapus transaksi.");
        } finally {
            setDeletingTx(false);
        }
    }

    async function logout() {
        const { error } = (await supabase()?.auth.signOut()) || {};
        if (error) {
            setNotice(error.message);
            return;
        }
        setSavedToken("");
        setDoc(null);
        setRev(null);
        setFilter("");
        setAccountFilter("");
        setSearch("");
        setAuthed(false);
        setDemoMode(true);
        setDialog(null);
        setRefresh(v => v + 1);
    }

    const dialogTitles: Record<Exclude<Dialog, null>, string> = {
        login: "Koneksi Server & Akun",
        entry:
            entryPreset.kind === "transfer"
                ? "Transfer Antar Dompet"
                : entryPreset.kind === "income"
                  ? "Catat Pemasukan"
                  : "Catat Transaksi",
        "edit-entry": "Ubah Transaksi",
        account: "Tambah Dompet Baru",
        "edit-account": "Ubah / Hapus Dompet",
        category: "Buat Kategori Baru",
        "edit-category": "Ubah / Hapus Kategori",
        detail: "Detail Transaksi",
        review: "Tinjau Bukti",
        receipt: "Foto Struk (Auto-Fill)",
    };

    function navContent() {
        return (
            <>
                <div className="brand">
                    <img src="/icon.svg" alt="" width="34" height="34" />
                    <span>SamSaku</span>
                </div>
                <nav aria-label="Menu utama" className="side-links">
                    {links.map(({ page: p, icon: Icon }, i) => (
                        <button
                            key={p}
                            className={(page === p ? "active " : "") + (i === 4 ? "section-break" : "")}
                            aria-current={page === p ? "page" : undefined}
                            onClick={() => nav(p)}
                        >
                            <Icon size={18} strokeWidth={1.8} />
                            {labels[p]}
                        </button>
                    ))}
                </nav>
                <div className="sidebar-footer">
                    <button
                        onClick={() => {
                            setMenu(false);
                            if (authed) logout();
                            else setDialog("login");
                        }}
                    >
                        {authed ? <LogOut size={17} /> : <LogIn size={17} />}{" "}
                        {authed ? "Keluar dari server" : "Hubungkan server"}
                    </button>
                </div>
            </>
        );
    }

    const startDay = data?.settings?.monthly_start_day || 1;

    return (
        <div className="app-shell">
            <aside className="sidebar">{navContent()}</aside>
            {menu && (
                <Modal title="Navigasi SamSaku" onClose={() => setMenu(false)}>
                    <div className="mobile-side">{navContent()}</div>
                </Modal>
            )}
            <main className="workspace" ref={main}>
                <header className="topbar">
                    <div className="crumb">
                        <button
                            className="icon-btn mobile-menu"
                            aria-label="Buka navigasi"
                            onClick={() => setMenu(true)}
                        >
                            <Menu size={21} />
                        </button>
                        <span className="desktop-crumb">SamSaku Wealth</span>
                        <ChevronRight className="desktop-crumb" size={13} />
                        <strong>{labels[page]}</strong>
                    </div>
                    <div className="top-actions">
                        <button
                            type="button"
                            className="icon-btn"
                            title={theme === "dark" ? "Ganti ke Mode Terang" : "Ganti ke Mode Gelap"}
                            aria-label="Ganti tema tampilan"
                            onClick={() => applyTheme(theme === "dark" ? "light" : "dark")}
                        >
                            {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
                        </button>
                        <button
                            type="button"
                            className="icon-btn"
                            title="Pengaturan siklus & aplikasi"
                            onClick={() => nav("settings")}
                        >
                            <SettingsIcon size={18} />
                        </button>
                        {ready && (
                            <button onClick={() => setDialog("login")} className="account-badge">
                                <span className={"dot " + (!demoMode ? (live ? "online live" : "online") : "")} />
                                {demoMode ? "Sandbox" : live ? "Live" : "Terhubung"}
                            </button>
                        )}
                        <span className="avatar" aria-hidden="true">
                            S
                        </span>
                    </div>
                </header>
                <div className="page-body">
                    <div className="page-heading">
                        <div>
                            <h1>{page === "home" ? "Ringkasan Keuangan" : labels[page]}</h1>
                            {["home", "transactions", "budgets", "stats"].includes(page) && month && (
                                <p>
                                    Siklus aktif: <b>{periodRangeLabel(month, startDay)}</b>
                                    {startDay !== 1 ? ` (Mulai tgl ${startDay})` : ""}
                                </p>
                            )}
                        </div>
                        <div className="heading-actions">
                            {["home", "transactions", "budgets", "stats"].includes(page) && month && (
                                <div className="cycle-picker">
                                    <button
                                        type="button"
                                        className="icon-btn"
                                        aria-label="Periode sebelumnya"
                                        onClick={() => {
                                            userPickedMonth.current = true;
                                            setMonth(shiftMonth(month, -1));
                                        }}
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
                                            onChange={e => {
                                                if (e.target.value) {
                                                    userPickedMonth.current = true;
                                                    setMonth(e.target.value);
                                                }
                                            }}
                                        />
                                    </label>
                                    <button
                                        type="button"
                                        className="icon-btn"
                                        aria-label="Periode berikutnya"
                                        onClick={() => {
                                            userPickedMonth.current = true;
                                            setMonth(shiftMonth(month, 1));
                                        }}
                                    >
                                        <ChevronRight size={17} />
                                    </button>
                                </div>
                            )}
                            {page === "home" && (
                                <>
                                    <button className="btn desktop-only-action" onClick={() => nav("stats")}>
                                        <BarChart3 size={16} /> Statistik
                                    </button>
                                    <button className="btn primary desktop-only-action" onClick={() => openEntry()}>
                                        <Plus size={16} /> Catat transaksi
                                    </button>
                                </>
                            )}
                        </div>
                    </div>

                    {error && (
                        <div className="card">
                            <ErrorNote message={error} />
                            <div className="btns">
                                <button className="btn" onClick={() => setRefresh(x => x + 1)}>
                                    Coba lagi
                                </button>
                                <button className="btn" onClick={() => setDialog("login")}>
                                    Pengaturan koneksi
                                </button>
                            </div>
                        </div>
                    )}

                    {(!ready || loading) && (
                        <div role="status" className="card loading">
                            Memuat data keuangan…
                        </div>
                    )}

                    {data && (
                        <>
                            {page === "home" && (
                                <Dashboard
                                    data={data}
                                    month={month}
                                    onCategory={n => {
                                        nav("transactions");
                                        setFilter(n);
                                    }}
                                    onTx={detail}
                                    onAccounts={() => nav("masters")}
                                    onEditAccount={a => {
                                        setSelectedAccount(a);
                                        write("edit-account");
                                    }}
                                    onAddAccount={() => {
                                        setSelectedAccount(null);
                                        write("account");
                                    }}
                                    onFilterAccount={accId => {
                                        nav("transactions");
                                        setAccountFilter(accId);
                                    }}
                                    onNewTx={() => openEntry({ kind: "expense" })}
                                    onScanReceipt={() => openEntry({ kind: "expense", autoScan: true })}
                                    onTransfer={fromAccId =>
                                        openEntry({ kind: "transfer", account_id: fromAccId })
                                    }
                                    onBudgets={() => nav("budgets")}
                                    onStats={() => nav("stats")}
                                    onAll={() => nav("transactions")}
                                    onReview={() => nav("reviews")}
                                />
                            )}

                            {page === "transactions" && (
                                <TransactionsView
                                    data={data}
                                    month={month}
                                    filter={filter}
                                    setFilter={setFilter}
                                    accountFilter={accountFilter}
                                    setAccountFilter={setAccountFilter}
                                    search={search}
                                    setSearch={setSearch}
                                    onOpenTx={detail}
                                    onAddAtDate={(date, kind) => openEntry({ date, kind: kind || "expense" })}
                                    onScanAtDate={date => openEntry({ date, kind: "expense", autoScan: true })}
                                    onTransferAtDate={date => openEntry({ date, kind: "transfer" })}
                                />
                            )}

                            {page === "budgets" && (
                                <BudgetsView
                                    data={data}
                                    month={month}
                                    onSelectCategory={catName => {
                                        nav("transactions");
                                        setFilter(catName);
                                    }}
                                    onDone={() => {
                                        setRefresh(x => x + 1);
                                        setNotice("Anggaran diperbarui.");
                                    }}
                                />
                            )}

                            {page === "stats" && (
                                <Statistics
                                    data={data}
                                    month={month}
                                    onSelectCategory={catName => {
                                        nav("transactions");
                                        setFilter(catName);
                                    }}
                                />
                            )}

                            {page === "reports" && (
                                <Reports
                                    data={data}
                                    month={month}
                                    demoMode={demoMode}
                                    setMonth={m => {
                                        userPickedMonth.current = true;
                                        setMonth(m);
                                    }}
                                />
                            )}

                            {page === "import" && (
                                <Importer
                                    data={data}
                                    demoMode={demoMode}
                                    onLogin={() => setDialog("login")}
                                    onDone={() => setRefresh(x => x + 1)}
                                />
                            )}

                            {page === "masters" && (
                                <div className="two-cols">
                                    <div className="stack">
                                        <Accounts
                                            data={data}
                                            onEdit={a => {
                                                setSelectedAccount(a);
                                                write("edit-account");
                                            }}
                                            onTransfer={fromAccId =>
                                                openEntry({ kind: "transfer", account_id: fromAccId })
                                            }
                                            onFilterAccount={accId => {
                                                nav("transactions");
                                                setAccountFilter(accId);
                                            }}
                                            onAdd={() => {
                                                setSelectedAccount(null);
                                                write("account");
                                            }}
                                        />
                                        {data.connections && (
                                            <section className="card">
                                                <div className="section-title">
                                                    <h2>Sumber transaksi otomatis</h2>
                                                </div>
                                                {data.connections.map(c => (
                                                    <div key={c.source} className="paper-line">
                                                        <span>{c.source.toUpperCase()}</span>
                                                        <small>
                                                            {c.last_received_at
                                                                ? new Date(c.last_received_at).toLocaleString("id-ID", {
                                                                      timeZone: "Asia/Jakarta",
                                                                  })
                                                                : "Belum ada bukti"}
                                                        </small>
                                                    </div>
                                                ))}
                                            </section>
                                        )}
                                    </div>
                                    <section className="card">
                                        <div className="section-title">
                                            <h2>Kategori</h2>
                                            <button
                                                className="btn primary sm"
                                                aria-label="Buat kategori"
                                                onClick={() => write("category")}
                                            >
                                                <Plus size={14} /> Kategori
                                            </button>
                                        </div>
                                        {(["income", "expense"] as const).map(k => (
                                            <div key={k} className="master-group">
                                                <h3 className={k === "income" ? "income" : "expense-amt"}>
                                                    {kindLabels[k]}
                                                </h3>
                                                {data.categories
                                                    .filter(c => c.kind === k)
                                                    .map(c => (
                                                        <button
                                                            className="list-action master-cat-row"
                                                            key={c.id}
                                                            onClick={() => {
                                                                setSelectedCategory(c);
                                                                write("edit-category");
                                                            }}
                                                        >
                                                            <span>
                                                                {c.parent_id ? "↳ " : ""}
                                                                {c.name}
                                                                {c.archived ? " · Diarsipkan" : ""}
                                                            </span>
                                                            <Pencil size={14} className="wallet-edit-icon" />
                                                        </button>
                                                    ))}
                                            </div>
                                        ))}
                                        <button className="text-btn" onClick={() => nav("import")}>
                                            <FileSpreadsheet size={15} /> Impor master dari Excel
                                        </button>
                                    </section>
                                </div>
                            )}

                            {page === "settings" && (
                                <SettingsView
                                    data={data}
                                    month={month}
                                    demoMode={demoMode}
                                    theme={theme}
                                    onToggleTheme={applyTheme}
                                    onDone={nextStartDay => {
                                        if (typeof nextStartDay === "number") {
                                            userPickedMonth.current = false;
                                            setMonth(cycleMonthForDate(today(), nextStartDay));
                                        }
                                        setRefresh(x => x + 1);
                                        setNotice("Pengaturan disimpan.");
                                    }}
                                />
                            )}

                            {page === "reviews" && (
                                <section className="card">
                                    <div className="section-title">
                                        <h2>Bukti menunggu keputusan</h2>
                                        <Inbox size={18} />
                                    </div>
                                    {data.reviews.length ? (
                                        data.reviews.map(r => (
                                            <button
                                                key={r.id}
                                                className="list-action"
                                                onClick={() => {
                                                    setRev(r);
                                                    setDialog("review");
                                                }}
                                            >
                                                <strong>{r.source}</strong>
                                                <small>{r.text}</small>
                                            </button>
                                        ))
                                    ) : (
                                        <p className="empty">Semua bukti sudah ditinjau.</p>
                                    )}
                                </section>
                            )}
                        </>
                    )}
                </div>
            </main>

            {/* Global Floating Action Button (FAB) */}
            {data && (
                <div className="fab-container">
                    {fabOpen && (
                        <div className="fab-menu">
                            <button
                                type="button"
                                className="fab-action"
                                onClick={() => openEntry({ kind: "expense", autoScan: true })}
                            >
                                <Camera size={16} /> Foto Struk (Auto-Fill)
                            </button>
                            {data.accounts.length >= 2 && (
                                <button
                                    type="button"
                                    className="fab-action"
                                    onClick={() => openEntry({ kind: "transfer" })}
                                >
                                    <ArrowLeftRight size={16} /> Transfer Antar Dompet
                                </button>
                            )}
                            <button
                                type="button"
                                className="fab-action"
                                onClick={() => openEntry({ kind: "income" })}
                            >
                                <Plus size={16} /> Catat Pemasukan
                            </button>
                            <button
                                type="button"
                                className="fab-action primary"
                                onClick={() => openEntry({ kind: "expense" })}
                            >
                                <Plus size={16} /> Catat Pengeluaran
                            </button>
                        </div>
                    )}
                    <button
                        type="button"
                        className={"fab-main " + (fabOpen ? "open" : "")}
                        aria-label="Aksi cepat transaksi"
                        onClick={() => setFabOpen(v => !v)}
                    >
                        {fabOpen ? <X size={22} /> : <Plus size={22} />}
                    </button>
                </div>
            )}

            <nav className="bottom-nav" aria-label="Navigasi bawah">
                {links.slice(0, 4).map(({ page: p, icon: Icon }) => (
                    <button
                        aria-current={page === p ? "page" : undefined}
                        key={p}
                        className={page === p ? "active" : ""}
                        onClick={() => nav(p)}
                    >
                        <Icon size={19} />
                        {labels[p]}
                    </button>
                ))}
                <button onClick={() => setMenu(true)} aria-label="Menu lainnya">
                    <Menu size={19} />
                    Lainnya
                </button>
            </nav>

            {notice && (
                <div className="toast" role="status">
                    {notice}
                </div>
            )}

            {dialog && (
                <Modal
                    title={dialogTitles[dialog]}
                    onClose={() => setDialog(null)}
                    wide={
                        dialog === "entry" ||
                        dialog === "edit-entry" ||
                        dialog === "receipt" ||
                        dialog === "account" ||
                        dialog === "edit-account"
                    }
                    key={dialog}
                >
                    {dialog === "login" && (
                        <Login
                            authed={authed}
                            onLogout={logout}
                            onLocal={() => {
                                setAuthed(true);
                                setDemoMode(false);
                                setDialog(null);
                                setRefresh(v => v + 1);
                            }}
                        />
                    )}

                    {data && (
                        <>
                            {dialog === "entry" && (
                                <EntryForm
                                    data={data}
                                    initial={{
                                        date: entryPreset.date,
                                        kind: entryPreset.kind,
                                        account_id: entryPreset.account_id,
                                    }}
                                    autoScan={entryPreset.autoScan}
                                    onDone={done}
                                />
                            )}

                            {dialog === "edit-entry" && doc && (
                                <EntryForm data={data} tx={doc} onDone={done} />
                            )}

                            {dialog === "account" && (
                                <MasterForm mode="account" data={data} onDone={done} />
                            )}

                            {dialog === "edit-account" && selectedAccount && (
                                <MasterForm
                                    mode="account"
                                    data={data}
                                    account={selectedAccount}
                                    onDone={done}
                                />
                            )}

                            {dialog === "category" && (
                                <MasterForm mode="category" data={data} onDone={done} />
                            )}

                            {dialog === "detail" && doc && (
                                <div className="detail">
                                    <div
                                        className={
                                            "detail-amount " +
                                            (doc.kind === "income" || doc.kind === "refund"
                                                ? "income"
                                                : doc.kind === "transfer"
                                                  ? "transfer-amt"
                                                  : "expense-amt")
                                        }
                                    >
                                        {doc.kind === "income" || doc.kind === "refund"
                                            ? "+"
                                            : doc.kind === "transfer"
                                              ? "⇄ "
                                              : "−"}
                                        {money(doc.amount)}
                                    </div>
                                    <h3>{doc.description || kindLabels[doc.kind]}</h3>
                                    {[
                                        ["Tanggal", doc.date],
                                        ["Jenis", kindLabels[doc.kind]],
                                        [
                                            doc.kind === "transfer" ? "Dompet asal" : "Dompet",
                                            doc.account_name ||
                                                data.accounts.find(a => a.id === doc.account_id)?.name,
                                        ],
                                        [
                                            "Dompet tujuan",
                                            doc.to_account_name ||
                                                data.accounts.find(a => a.id === doc.to_account_id)?.name,
                                        ],
                                        [
                                            "Kategori",
                                            doc.category_name ||
                                                data.categories.find(c => c.id === doc.category_id)?.name,
                                        ],
                                        ["Biaya admin", doc.fee ? money(doc.fee) : null],
                                        ["Sumber", doc.source],
                                    ].map(([key, val]) =>
                                        val ? (
                                            <div className="paper-line" key={key}>
                                                <span>{key}</span>
                                                <b>{val}</b>
                                            </div>
                                        ) : null
                                    )}

                                    {doc.splits && doc.splits.filter(s => s.role !== "fee").length > 1 && (
                                        <div className="split-detail-box">
                                            <strong>Rincian Split Kategori</strong>
                                            {doc.splits
                                                .filter(s => s.role !== "fee")
                                                .map((s, idx) => {
                                                    const cName =
                                                        s.category_name ||
                                                        data.categories.find(c => c.id === s.category_id)?.name ||
                                                        "Belum dikategorikan";
                                                    return (
                                                        <div className="paper-line" key={idx}>
                                                            <span>{cName}</span>
                                                            <b>{money(Math.abs(s.amount))}</b>
                                                        </div>
                                                    );
                                                })}
                                        </div>
                                    )}

                                    <div className="btns" style={{ marginTop: 18 }}>
                                        <button
                                            type="button"
                                            className="btn primary"
                                            onClick={() => write("edit-entry")}
                                        >
                                            <Pencil size={15} /> Ubah transaksi
                                        </button>
                                        {!confirmDeleteTx && (
                                            <button
                                                type="button"
                                                className="btn danger-outline"
                                                onClick={() => setConfirmDeleteTx(true)}
                                            >
                                                <Trash2 size={15} /> Hapus
                                            </button>
                                        )}
                                    </div>

                                    {confirmDeleteTx && (
                                        <div className="danger-box" style={{ marginTop: 14 }}>
                                            <strong>Hapus transaksi ini?</strong>
                                            <p className="muted">
                                                Tindakan ini akan menghapus transaksi dan memperbarui saldo dompet.
                                            </p>
                                            <div className="btns">
                                                <button
                                                    type="button"
                                                    className="btn danger"
                                                    disabled={deletingTx}
                                                    onClick={deleteCurrentTx}
                                                >
                                                    {deletingTx ? "Menghapus…" : "Ya, hapus"}
                                                </button>
                                                <button
                                                    type="button"
                                                    className="btn"
                                                    onClick={() => setConfirmDeleteTx(false)}
                                                >
                                                    Batal
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}

                            {dialog === "edit-category" && selectedCategory && (
                                <CategoryEdit
                                    category={selectedCategory}
                                    categories={data.categories}
                                    done={done}
                                />
                            )}

                            {dialog === "receipt" && (
                                <EntryForm
                                    data={data}
                                    initial={{ date: entryPreset.date, kind: "expense" }}
                                    autoScan={true}
                                    onDone={done}
                                />
                            )}

                            {dialog === "review" && rev && <ReviewItem r={rev} data={data} done={done} />}
                        </>
                    )}
                </Modal>
            )}
        </div>
    );
}

function ReviewItem({ r, data, done }: { r: Review; data: Data; done: () => void }) {
    const [id, setId] = useState("");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    async function act(action: string) {
        setBusy(true);
        setError("");
        try {
            await post("/reviews/" + r.id + "/resolve", { action, transaction_id: id || undefined });
            done();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Gagal menyimpan.");
        } finally {
            setBusy(false);
        }
    }
    return (
        <div className="form">
            <p className="evidence">{r.text}</p>
            <Field label="Transaksi terkait">
                <select value={id} onChange={e => setId(e.target.value)}>
                    <option value="">Pilih transaksi</option>
                    {data.transactions.map(t => (
                        <option key={t.id} value={t.id}>
                            {t.date} · {t.description} · {money(t.amount)}
                        </option>
                    ))}
                </select>
            </Field>
            <div className="btns">
                <button className="btn primary" disabled={busy || !id} onClick={() => act("link")}>
                    Tautkan
                </button>
                <button className="btn" disabled={busy} onClick={() => act("ignore")}>
                    Abaikan bukti
                </button>
            </div>
            <details>
                <summary>Catat sebagai transaksi baru</summary>
                <EntryForm
                    data={data}
                    onDone={done}
                    initial={{
                        ...r.parsed,
                        description: r.parsed?.description || r.parsed?.merchant || r.text.slice(0, 500),
                    }}
                    submitPath={"/reviews/" + r.id + "/resolve"}
                    wrap={transaction => ({ action: "post", transaction })}
                />
            </details>
            <ErrorNote message={error} />
        </div>
    );
}

function Login({
    authed,
    onLogout,
    onLocal,
}: {
    authed: boolean;
    onLogout: () => void;
    onLocal: () => void;
}) {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [key, setKey] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    async function emailLogin(e: React.FormEvent) {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
            const sb = supabase();
            if (!sb) throw new Error("Koneksi Supabase belum dikonfigurasi.");
            const { error } = await sb.auth.signInWithPassword({
                email: email.trim(),
                password,
            });
            if (error) throw error;
            onLocal();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Email atau password tidak sesuai.");
        } finally {
            setBusy(false);
        }
    }

    async function google() {
        setBusy(true);
        setError("");
        try {
            const sb = supabase();
            if (!sb) throw new Error("Login Google belum dikonfigurasi pada aplikasi ini.");
            const { error } = await sb.auth.signInWithOAuth({
                provider: "google",
                options: { redirectTo: location.origin + "/" },
            });
            if (error) throw error;
        } catch (e) {
            setError(e instanceof Error ? e.message : "Login gagal.");
            setBusy(false);
        }
    }
    async function local() {
        setError("");
        setBusy(true);
        try {
            setSavedToken(key.trim());
            await get("/accounts");
            onLocal();
        } catch (e) {
            setSavedToken("");
            setError(e instanceof Error ? e.message : "Password/Token akses tidak sesuai.");
        } finally {
            setBusy(false);
        }
    }
    return authed ? (
        <div className="form">
            <p className="muted">Terhubung ke database PostgreSQL SamSaku.</p>
            <button className="btn" onClick={onLogout}>
                Keluar ke Sandbox Interaktif
            </button>
        </div>
    ) : (
        <div className="form">
            <p className="muted">
                Masuk ke akun pemilik untuk menyinkronkan data dengan database PostgreSQL.
            </p>
            {supabase() && (
                <>
                    <form className="form" onSubmit={emailLogin}>
                        <Field label="Email pemilik">
                            <input
                                type="email"
                                required
                                value={email}
                                onChange={e => setEmail(e.target.value)}
                                placeholder="nama@email.com"
                            />
                        </Field>
                        <Field label="Password">
                            <input
                                type="password"
                                required
                                value={password}
                                onChange={e => setPassword(e.target.value)}
                                placeholder="••••••••"
                            />
                        </Field>
                        <button type="submit" disabled={busy || !email || !password} className="btn primary">
                            <LogIn size={16} /> Masuk dengan Email
                        </button>
                    </form>
                    <button type="button" disabled={busy} className="btn" onClick={google}>
                        <LogIn size={16} /> Masuk dengan Google (Opsional)
                    </button>
                </>
            )}
            {allowDev() && (
                <>
                    <Field label="Password / Token Akses Server (SAMSAKU_DEV_TOKEN)">
                        <input
                            type="password"
                            value={key}
                            autoComplete="off"
                            onChange={e => setKey(e.target.value)}
                            placeholder="Masukkan password/token akses Anda"
                        />
                    </Field>
                    <button disabled={busy || !key} className="btn primary" onClick={local}>
                        Hubungkan Server SamSaku
                    </button>
                </>
            )}
            {!supabase() && !allowDev() && <p>Login belum dikonfigurasi. Atur koneksi Supabase pada deployment.</p>}
            <ErrorNote message={error} />
        </div>
    );
}
