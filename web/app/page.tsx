"use client";
import { useEffect, useRef, useState } from "react";
import { CalendarDays, ChevronDown, ChevronRight, Database, FileChartColumnIncreasing, FileSpreadsheet, Home, Inbox, Layers3, LogIn, LogOut, Menu, Plus, ReceiptText, ScanLine, Search } from "lucide-react";
import { allowDev, get, post, supabase } from "../lib/api";
import { type Data, type Transaction, type Review, type Scheme, categoryMatches, kindLabels, monthLabel, money, period, today } from "../lib/domain";
import { demo } from "../lib/demo";
import { Dashboard, Accounts } from "../components/Dashboard";
import { TxList, Field, Modal, ErrorNote } from "../components/ui";
import { CategoryEdit } from "../components/CategoryEdit";
import { EntryForm, MasterForm } from "../components/Entries";
import { Plans, SchemeForm, Allocate } from "../components/Planning";
import { Importer } from "../components/Importer";
import { Reports } from "../components/Reports";
import { Receipt } from "../components/Receipt";
type Page = "home" | "transactions" | "reports" | "import" | "masters" | "plans" | "reviews";
const labels: Record<Page, string> = { home: "Ringkasan", transactions: "Transaksi", reports: "Laporan", import: "Impor Excel", masters: "Master data", plans: "Atur uang", reviews: "Perlu ditinjau" };
const links = [{ page: "home", icon: Home }, { page: "transactions", icon: ReceiptText }, { page: "reports", icon: FileChartColumnIncreasing }, { page: "import", icon: FileSpreadsheet }, { page: "masters", icon: Database }, { page: "plans", icon: Layers3 }] as const;
type Dialog = "login" | "entry" | "account" | "category" | "edit-category" | "goal" | "scheme" | "detail" | "allocate" | "review" | "receipt" | null;
export default function Page() {
    const [month, setMonth] = useState(""), [page, setPage] = useState<Page>("home"), [data, setData] = useState<Data | null>(null), [demoMode, setDemoMode] = useState(true), [authed, setAuthed] = useState(false), [ready, setReady] = useState(false), [refresh, setRefresh] = useState(0), [error, setError] = useState(""), [loading, setLoading] = useState(false);
    const [dialog, setDialog] = useState<Dialog>(null), [menu, setMenu] = useState(false), [filter, setFilter] = useState(""), [search, setSearch] = useState(""), [doc, setDoc] = useState<Transaction | null>(null), [rev, setRev] = useState<Review | null>(null), [scheme, setScheme] = useState<Scheme | null>(null), [notice, setNotice] = useState("");
    const [selectedCategory, setSelectedCategory] = useState<Data["categories"][number] | null>(null);
    const main = useRef<HTMLElement>(null);
    const loadedMonth = useRef("");
    useEffect(() => {
        setMonth(today().slice(0, 7));
        const sb = supabase();
        let alive = true;
        const listen = sb?.auth.onAuthStateChange((_ev, session) => {
            if (alive) {
                const ok = !!session || allowDev() && !!sessionStorage.getItem("samsaku-dev");
                setAuthed(ok);
                setDemoMode(!ok);
                if (!ok) {
                    setData(null);
                    setDialog(null);
                    setDoc(null);
                    setRev(null);
                    setScheme(null);
                }
                setReady(true);
            }
        });
        if (!sb) {
            const ok = allowDev() && !!sessionStorage.getItem("samsaku-dev");
            setAuthed(ok);
            setDemoMode(!ok);
            setReady(true);
        }
        if ("serviceWorker" in navigator && process.env.NODE_ENV === "production")
            navigator.serviceWorker.register("/sw.js").catch(() => { });
        return () => { alive = false; listen?.data.subscription.unsubscribe(); };
    }, []);
    useEffect(() => {
        if (!month || !ready)
            return;
        let valid = true;
        setError("");
        if (demoMode) {
            loadedMonth.current = "";
            setData(demo(month));
            setLoading(false);
            return;
        }
        if (loadedMonth.current !== month) setData(null);
        setLoading(true);
        const q = "?" + new URLSearchParams(period(month));
        Promise.all([get<Data["accounts"]>("/accounts"), get<Data["categories"]>("/categories"), get<Data["reviews"]>("/reviews"), get<Data["schemes"]>("/schemes"), get<Data["goals"]>("/goals"), get<Data["summary"]>("/summary" + q), get<Data["connections"]>("/connections")]).then(([accounts, categories, reviews, schemes, goals, summary, connections]) => {
            if (valid) {
                loadedMonth.current = month;
                setData({ accounts, categories, transactions: summary.transactions, reviews, schemes, goals, summary, connections });
            }
        }).catch(e => {
            if (valid)
                setError(e.message);
        }).finally(() => {
            if (valid)
                setLoading(false);
        });
        return () => { valid = false; };
    }, [month, ready, demoMode, refresh]);
    useEffect(() => {
        if (!notice)
            return;
        const timer = setTimeout(() => setNotice(""), 4000);
        return () => clearTimeout(timer);
    }, [notice]);
    function nav(p: Page) { setPage(p); setMenu(false); setFilter(""); setSearch(""); window.scrollTo({ top: 0 }); }
    function write(d: Dialog) { setDialog(demoMode ? "login" : d); }
    function done() { setDialog(null); setRefresh(v => v + 1); setNotice("Perubahan tersimpan."); }
    const detail = (t: Transaction) => { setDoc(t); setDialog("detail"); };
    async function logout() {
        const { error } = await supabase()?.auth.signOut() || {};
        if (error) {
            setNotice(error.message);
            return;
        }
        sessionStorage.removeItem("samsaku-dev");
        setData(null);
        setDoc(null);
        setRev(null);
        setScheme(null);
        setFilter("");
        setSearch("");
        setAuthed(false);
        setDemoMode(true);
        setDialog(null);
    }
    const dialogTitles: Record<Exclude<Dialog, null>, string> = { login: "Hubungkan SamSaku", entry: "Catat transaksi", account: "Tambah dompet", category: "Buat kategori", "edit-category": "Ubah kategori", goal: "Buat target tabungan", scheme: "Buat skema keuangan", detail: "Detail transaksi", allocate: "Bagi pemasukan", review: "Tinjau bukti", receipt: "Baca foto struk" };
    function navContent() {
        return <>
      <div className="brand">
        <img src="/icon.svg" alt="" width="34" height="34"/>
        <span>SamSaku</span>
      </div>
      <nav aria-label="Menu utama" className="side-links">
        {links.map(({ page: p, icon: Icon }, i) => <button key={p} className={(page === p ? "active " : "") + (i === 3 ? "section-break" : "")} aria-current={page === p ? "page" : undefined} onClick={() => nav(p)}>
          <Icon size={18} strokeWidth={1.7}/>
          {labels[p]}
        </button>)}
      </nav>
      <div className="sidebar-footer">
        <button onClick={() => {
                setMenu(false);
                if (authed)
                    logout();
                else
                    setDialog("login");
            }}>
          {authed ? <LogOut size={17}/> : <LogIn size={17}/>}
          {" "}
          {authed ? "Keluar dari akun" : "Hubungkan akun"}
        </button>
      </div>
    </>;
    }
    return <div className="app-shell">
      <aside className="sidebar">
        {navContent()}
      </aside>
      {menu && <Modal title="Menu SamSaku" onClose={() => setMenu(false)}>
        <div className="mobile-side">
          {navContent()}
        </div>
      </Modal>}
      <main className="workspace" ref={main}>
        <header className="topbar">
          <div className="crumb">
            <button className="icon-btn mobile-menu" aria-label="Buka navigasi" onClick={() => setMenu(true)}>
              <Menu size={21}/>
            </button>
            <span className="desktop-crumb">Keuangan pribadi</span>
            <ChevronRight className="desktop-crumb" size={13}/>
            <strong>
              {labels[page]}
            </strong>
          </div>
          <div className="top-actions">
            {ready && <button onClick={() => setDialog("login")} className="account-badge">
              <span className={"dot " + (!demoMode ? "online" : "")}/>
              {demoMode ? "Data contoh" : "Akun pribadi"}
            </button>}
            <span className="avatar" aria-hidden="true">S</span>
          </div>
        </header>
        <div className="page-body">
          <div className="page-heading">
            <div>
              <h1>
                {page === "home" ? "Ringkasan keuangan" : labels[page]}
              </h1>
              {page === "home" && month && <p>
                {new Date(today() + "T12:00:00").toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
              </p>}
            </div>
            <div className="heading-actions">
              {["home", "transactions", "plans"].includes(page) && month && <label className="month-btn">
                <CalendarDays size={16}/>
                <span>
                  {monthLabel(month)}
                </span>
                <ChevronDown size={14}/>
                <input aria-label="Bulan tampilan" type="month" value={month} onChange={e => e.target.value && setMonth(e.target.value)}/>
              </label>}
              {page === "home" && <button className="btn primary" onClick={() => nav("reports")}><FileChartColumnIncreasing size={16}/> Laporan</button>}
              {page === "transactions" && <button className="btn primary" onClick={() => write("entry")}><Plus size={16}/>Catat transaksi</button>}
            </div>
          </div>
 
          {error && <div className="card">
            <ErrorNote message={error}/>
            <div className="btns">
              <button className="btn" onClick={() => setRefresh(x => x + 1)}>Coba lagi</button>
              <button className="btn" onClick={() => setDialog("login")}>Pengaturan akun</button>
            </div>
          </div>}
 
          {(!ready || loading) && <div role="status" className="card loading">Memuat data keuangan…</div>}
 
          {data && <>
 
            {page === "home" && <Dashboard data={data} month={month} onCategory={n => { nav("transactions"); setFilter(n); }} onTx={detail} onAccounts={() => nav("masters")} onAll={() => nav("transactions")} onReview={() => nav("reviews")}/>}
 
            {page === "transactions" && <section className="card">
              <div className="filter-bar">
                <label className="search">
                  <Search size={17}/>
                  <input placeholder="Cari transaksi atau dompet" aria-label="Cari transaksi" value={search} onChange={e => setSearch(e.target.value)}/>
                </label>
                <select aria-label="Filter kategori" value={filter} onChange={e => setFilter(e.target.value)}>
                  <option value="">Semua kategori</option>
                  {[...new Set([...data.categories.map(c => c.name), ...data.summary.categories.map(c => c.name)])].map(c => <option key={c}>
                    {c}
                  </option>)}
                </select>
                <button className="btn" onClick={() => write("receipt")}><ScanLine size={16}/>Foto struk</button>
              </div>
              <TxList rows={data.transactions.filter(t => categoryMatches(t, filter, data.categories) && [t.description, t.account_name, t.category_name, t.amount].join(" ").toLowerCase().includes(search.toLowerCase()))} accounts={data.accounts} open={detail}/>
            </section>}
 
            {page === "reports" && <Reports data={data} month={month} demoMode={demoMode} setMonth={setMonth}/>}
 
            {page === "import" && <Importer data={data} demoMode={demoMode} onLogin={() => setDialog("login")} onDone={() => setRefresh(x => x + 1)}/>}
 
            {page === "masters" && <div className="two-cols">
              <div className="stack">
                <Accounts data={data}/>
                {data.connections && <section className="card">
                  <div className="section-title">
                    <h2>Sumber transaksi</h2>
                  </div>
                  {data.connections.map(c => <div key={c.source} className="paper-line">
                    <span>
                      {c.source.toUpperCase()}
                    </span>
                    <small>
                      {c.last_received_at ? new Date(c.last_received_at).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }) : "Belum ada bukti"}
                    </small>
                  </div>)}
                </section>}
                <button className="btn" onClick={() => write("account")}><Plus size={16}/>Tambah dompet</button>
              </div>
              <section className="card">
                <div className="section-title">
                  <h2>Kategori</h2>
                  <button className="icon-btn" aria-label="Buat kategori" onClick={() => write("category")}>
                    <Plus size={18}/>
                  </button>
                </div>
                {(["income", "expense"] as const).map(k => <div key={k} className="master-group">
                  <h3>
                    {kindLabels[k]}
                  </h3>
                  {data.categories.filter(c => c.kind === k).map(c => <button className="list-action" key={c.id} onClick={() => { setSelectedCategory(c); write("edit-category"); }}>
                    {c.parent_id ? "↳ " : ""}
                    {c.name}
                    {c.archived ? " · Diarsipkan" : ""}
                  </button>)}
                </div>)}
                <button className="text-btn" onClick={() => nav("import")}><FileSpreadsheet size={15}/>Impor master dari Excel</button>
              </section>
            </div>}
 
            {page === "plans" && <Plans data={data} newGoal={() => write("goal")} newScheme={() => write("scheme")} select={s => { setScheme(s); write("allocate"); }}/>}
 
            {page === "reviews" && <section className="card">
              <div className="section-title">
                <h2>Bukti menunggu keputusan</h2>
                <Inbox size={18}/>
              </div>
              {data.reviews.length ? data.reviews.map(r => <button key={r.id} className="list-action" onClick={() => { setRev(r); setDialog("review"); }}>
                <strong>
                  {r.source}
                </strong>
                <small>
                  {r.text}
                </small>
              </button>) : <p className="empty">Semua bukti sudah ditinjau.</p>}
            </section>}
          </>}
        </div>
      </main>
      <nav className="bottom-nav" aria-label="Navigasi bawah">
        {links.slice(0, 3).map(({ page: p, icon: Icon }) => <button aria-current={page === p ? "page" : undefined} key={p} className={page === p ? "active" : ""} onClick={() => nav(p)}>
          <Icon size={19}/>
          {labels[p]}
        </button>)}
        <button onClick={() => setMenu(true)} aria-label="Menu lainnya"><Menu size={19}/>Lainnya</button>
      </nav>
 
      {notice && <div className="toast" role="status">
        {notice}
      </div>}
 
      {dialog && <Modal title={dialogTitles[dialog]} onClose={() => setDialog(null)} wide={dialog === "scheme"} key={dialog}>
 
        {dialog === "login" && <Login authed={authed} onLogout={logout} onLocal={() => { setAuthed(true); setDemoMode(false); setDialog(null); setRefresh(v => v + 1); }}/>}
 
        {data && <>
          {dialog === "entry" && <EntryForm data={data} onDone={done}/>}
 
          {(dialog === "category" || dialog === "account" || dialog === "goal") && <MasterForm mode={dialog} data={data} onDone={done}/>}
 
          {dialog === "detail" && doc && <div className="detail">
            <div className="detail-amount">
              {money(doc.amount)}
            </div>
            <h3>
              {doc.description || kindLabels[doc.kind]}
            </h3>
            {[["Tanggal", doc.date], ["Jenis", kindLabels[doc.kind]], ["Dompet", doc.account_name || data.accounts.find(a => a.id === doc.account_id)?.name], ["Kategori", doc.category_name || data.categories.find(c => c.id === doc.category_id)?.name], ["Dompet tujuan", data.accounts.find(a => a.id === doc.to_account_id)?.name], ["Biaya admin", doc.fee ? money(doc.fee) : null], ["Sumber", doc.source]].map(([key, val]) => val ? <div className="paper-line" key={key}>
              <span>
                {key}
              </span>
              <b>
                {val}
              </b>
            </div> : null)}
          </div>}
 
          {dialog === "edit-category" && selectedCategory && <CategoryEdit category={selectedCategory} done={done}/>}
 
          {dialog === "scheme" && <SchemeForm data={data} done={done}/>}
 
          {dialog === "allocate" && scheme && <Allocate scheme={scheme} data={data} done={done}/>}
 
          {dialog === "receipt" && <Receipt data={data} done={done}/>}
 
          {dialog === "review" && rev && <ReviewItem r={rev} data={data} done={done}/>}
        </>}
      </Modal>}
    </div>;
}
function ReviewItem({ r, data, done }: {
    r: Review;
    data: Data;
    done: () => void;
}) {
    const [id, setId] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
    async function act(action: string) {
        setBusy(true);
        setError("");
        try {
            await post("/reviews/" + r.id + "/resolve", { action, transaction_id: id || undefined });
            done();
        }
        catch (e) {
            setError(e instanceof Error ? e.message : "Gagal menyimpan.");
        }
        finally {
            setBusy(false);
        }
    }
    return <div className="form">
      <p className="evidence">
        {r.text}
      </p>
      <Field label="Transaksi terkait">
        <select value={id} onChange={e => setId(e.target.value)}>
          <option value="">Pilih transaksi</option>
          {data.transactions.map(t => <option key={t.id} value={t.id}>{t.date} · {t.description} · {money(t.amount)}</option>)}
        </select>
      </Field>
      <div className="btns">
        <button className="btn primary" disabled={busy || !id} onClick={() => act("link")}>Tautkan</button>
        <button className="btn" disabled={busy} onClick={() => act("ignore")}>Abaikan bukti</button>
      </div>
      <details>
        <summary>Catat sebagai transaksi baru</summary>
        <EntryForm data={data} onDone={done} initial={{ ...r.parsed, description: r.parsed?.description || r.parsed?.merchant || r.text.slice(0, 500) }} submitPath={"/reviews/" + r.id + "/resolve"} wrap={transaction => ({ action: "post", transaction })}/>
      </details>
      <ErrorNote message={error}/>
    </div>;
}
function Login({ authed, onLogout, onLocal }: {
    authed: boolean;
    onLogout: () => void;
    onLocal: () => void;
}) {
    const [key, setKey] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
    async function google() {
        setBusy(true);
        setError("");
        try {
            const sb = supabase();
            if (!sb)
                throw new Error("Login Google belum dikonfigurasi pada aplikasi ini.");
            const { error } = await sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.origin + "/" } });
            if (error)
                throw error;
        }
        catch (e) {
            setError(e instanceof Error ? e.message : "Login gagal.");
            setBusy(false);
        }
    }
    async function local() {
        setError("");
        setBusy(true);
        try {
            sessionStorage.setItem("samsaku-dev", key);
            await get("/accounts");
            onLocal();
        }
        catch (e) {
            sessionStorage.removeItem("samsaku-dev");
            setError(e instanceof Error ? e.message : "Login gagal.");
        }
        finally {
            setBusy(false);
        }
    }
    return authed ? <button className="btn" onClick={onLogout}>Keluar dari akun</button> : <div className="form">
      <p className="muted">Masuk untuk melihat data pribadimu, mencatat transaksi, dan mengimpor workbook.</p>
      {supabase() && <button disabled={busy} className="btn primary" onClick={google}><LogIn size={16}/>Masuk dengan Google</button>}
      {allowDev() && <>
        <Field label="Token server lokal">
          <input type="password" value={key} autoComplete="off" onChange={e => setKey(e.target.value)}/>
        </Field>
        <button disabled={busy || !key} className="btn" onClick={local}>Hubungkan server lokal</button>
      </>}
      {!supabase() && !allowDev() && <p>Login belum dikonfigurasi. Atur koneksi Supabase pada deployment.</p>}
      <ErrorNote message={error}/>
    </div>;
}
