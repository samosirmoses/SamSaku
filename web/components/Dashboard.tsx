"use client";
import { ArrowDownLeft, ArrowUpRight, ArrowRight, ChevronRight, Wallet, Landmark, Smartphone, Coins, Inbox } from "lucide-react";
import { type Data, type Transaction, expense, money, period } from "../lib/domain";
import { CatIcon, TxList } from "./ui";
export function Categories({ data, onSelect }: {
    data: Data;
    onSelect: (name: string) => void;
}) {
    const cats = data.summary.categories.filter(c => c.amount > 0).sort((a, b) => b.amount - a.amount);
    return <div className="categories">
      {cats.length ? cats.map((c, i) => <button key={c.name} className="category-row" onClick={() => onSelect(c.name)}>
        <span className={"cat-icon tone-" + (i % 5)}>
          <CatIcon name={c.name}/>
        </span>
        <span className="category-text">
          <span className="category-label">
            <strong>
              {c.name}
            </strong>
            <b>
              {money(c.amount)}
            </b>
          </span>
          <span className="bar-line">
            <span className="bar-track">
              <span className={"bar bar-" + i % 5} style={{ width: Math.max(1, 100 * c.amount / cats[0].amount) + "%" }}/>
            </span>
            <small>{data.summary.expense > 0 ? Math.round(100 * c.amount / data.summary.expense) : 0}%</small>
          </span>
        </span>
      </button>) : <p className="empty">Kategori pengeluaran muncul setelah transaksi pertama.</p>}
    </div>;
}
function SpendingLine({ rows, month }: {
    rows: Transaction[];
    month: string;
}) {
    const days = Number(period(month).end.slice(-2));
    let sum = 0;
    const dayTotals = Array(days).fill(0) as number[];
    for (const t of rows) {
        const d = Number(t.date.slice(8, 10));
        if (d >= 1 && d <= days)
            dayTotals[d - 1] += expense(t);
    }
    const cumulative = dayTotals.map(v => (sum += v));
    const max = Math.max(1, ...cumulative), min = Math.min(0, ...cumulative), w = 320, h = 82;
    const points = [0, ...cumulative].map((n, i) => [2 + i / days * (w - 4), h - 6 - (n - min) / (max - min) * (h - 14)]);
    const line = points.map(p => p.join(",")).join(" ");
    const last = points[points.length - 1];
    return <div className="spend-graph">
      <div className="graph-label">Tren kumulatif</div>
      <svg viewBox={"0 0 " + w + " " + h} role="img" aria-label={"Tren pengeluaran kumulatif sampai tanggal " + days}>
        <defs>
          <linearGradient id="spend-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#c9b388" stopOpacity=".2"/>
            <stop offset="100%" stopColor="#c9b388" stopOpacity="0"/>
          </linearGradient>
        </defs>
        {[.2, .55, .90].map(y => <line key={y} x1="0" y1={h * y} x2={w} y2={h * y} stroke="#ffffff" strokeOpacity=".12" strokeDasharray="2 5"/>)}
        <polygon points={"2," + h + " " + line + " " + (w - 2) + "," + h} fill="url(#spend-fill)"/>
        <polyline points={line} fill="none" stroke="#d8c498" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round"/>
        <circle cx={last[0]} cy={last[1]} r="3" fill="#e2cda1"/>
      </svg>
      <div className="graph-labels">
        <span>1</span>
        <span>
          {days}
        </span>
      </div>
    </div>;
}
export function Accounts({ data, onOpen }: {
    data: Data;
    onOpen?: () => void;
}) {
    return <section className="card">
      <div className="section-title">
        <h2>Dompet saya</h2>
        <Wallet size={18}/>
      </div>
      {data.accounts.length ? <div className="wallets">
        {data.accounts.map(a => { const Icon = /bca|bank/i.test(a.name) ? Landmark : /tunai|cash/i.test(a.name) ? Coins : Smartphone; const Row = onOpen ? "button" : "div"; return <Row className="wallet-row" key={a.id} onClick={onOpen}>
          <span className="wallet-icon">
            <Icon size={18}/>
          </span>
          <span>
            {a.name}
            {!!a.reserved && <small className="wallet-free">Bebas {money(a.free_balance || 0)}</small>}
          </span>
          <strong>
            {a.balance == null ? "Saldo belum diatur" : money(a.balance)}
          </strong>
        </Row>; })}
      </div> : onOpen ? <button onClick={onOpen} className="text-btn">+ Tambah dompet pertama</button> : <p className="empty">Belum ada dompet.</p>}
    </section>;
}
export function Dashboard({ data, month, onCategory, onTx, onAll, onAccounts, onReview }: {
    data: Data;
    month: string;
    onCategory: (c: string) => void;
    onTx: (t: Transaction) => void;
    onAll: () => void;
    onAccounts: () => void;
    onReview: () => void;
}) {
    const s = data.summary;
    return <>
      <section className="hero">
        <div className="hero-top">
          <div>
            <p>Pengeluaran bulan ini</p>
            <h2>
              {money(s.expense)}
            </h2>
          </div>
          <SpendingLine rows={data.transactions} month={month}/>
        </div>
        <div className="hero-bottom">
          <div>
            <span className="hero-mini"><ArrowDownLeft size={15}/> Pemasukan</span>
            <strong>
              {money(s.income)}
            </strong>
          </div>
          <div>
            <span className="hero-mini"><ArrowUpRight size={15}/> Arus kas bersih</span>
            <strong>
              {s.net > 0 ? "+" : ""}
              {money(s.net)}
            </strong>
          </div>
        </div>
      </section>
 
      {s.partial_history && <p className="partial-note">Riwayat sebagian · Periode memuat transaksi sebelum tanggal saldo awal.</p>}
      <div className="dashboard-grid">
        <div className="stack">
          <section className="card">
            <div className="section-title">
              <h2>Pengeluaran per kategori</h2>
            </div>
            <Categories data={data} onSelect={onCategory}/>
          </section>
        </div>
        <div className="stack">
          <Accounts data={data} onOpen={onAccounts}/>
          {s.reviews > 0 && <button className="review-card" onClick={onReview}>
            <Inbox size={22}/>
            <span>
              <strong>Perlu ditinjau</strong>
              <small>{s.reviews} bukti menunggu keputusan</small>
            </span>
            <ChevronRight size={16}/>
          </button>}
          <section className="card recent">
            <div className="section-title">
              <h2>Transaksi terakhir</h2>
              <button className="icon-btn" onClick={onAll} aria-label="Semua transaksi">
                <ArrowRight size={18}/>
              </button>
            </div>
            <TxList rows={data.transactions.slice(0, 4)} accounts={data.accounts} open={onTx}/>
          </section>
        </div>
      </div>
    </>;
}
