"use client";
import { useState, type FormEvent } from "react";
import { Plus, Trash2, Layers3, Target } from "lucide-react";
import { post } from "../lib/api";
import { type Data, type Rule, type Scheme, money, today } from "../lib/domain";
import { Field, ErrorNote } from "./ui";
const initial = (): Rule => ({ name: "", mode: "percent", value: 0, category_ids: [] });
export function SchemeForm({ data, done }: {
    data: Data;
    done: () => void;
}) {
    const [rules, setRules] = useState<Rule[]>([initial()]), [busy, setBusy] = useState(false), [error, setError] = useState("");
    function edit(i: number, patch: Partial<Rule>) { setRules(prev => prev.map((r, n) => n === i ? { ...r, ...patch } : r)); }
    async function submit(e: FormEvent<HTMLFormElement>) { e.preventDefault(); setBusy(true); setError(""); const f = new FormData(e.currentTarget); try {
        await post("/schemes", { name: f.get("name"), cycle_day: Number(f.get("cycle")), rules: rules.map(r => ({ ...r, name: r.name.trim() })) });
        done();
    }
    catch (e) {
        setError(e instanceof Error ? e.message : "Gagal menyimpan skema.");
    }
    finally {
        setBusy(false);
    } }
    return <form className="form" onSubmit={submit}>
      <Field label="Nama skema">
        <input required name="name" placeholder="Rencana gajian"/>
      </Field>
      <Field label="Tanggal awal siklus bulanan">
        <input name="cycle" type="number" min="1" max="31" defaultValue="1" required/>
      </Field>
      {rules.map((r, i) => <fieldset className="rule" key={i}>
        <legend>Pos {i + 1}</legend>
        <Field label="Nama pos">
          <input required value={r.name} onChange={e => edit(i, { name: e.target.value })}/>
        </Field>
        <div className="form-pair">
          <Field label="Aturan">
            <select value={r.mode} onChange={e => edit(i, { mode: e.target.value as Rule["mode"], value: 0 })}>
              <option value="fixed">Nominal tetap</option>
              <option value="percent">Persentase</option>
              <option value="remainder">Seluruh sisa</option>
            </select>
          </Field>
          {r.mode !== "remainder" && <Field label={r.mode === "fixed" ? "Nominal (Rp)" : "Persen (%)"}>
            <input type="number" min="0" max={r.mode === "percent" ? 100 : undefined} step="1" value={r.value} onChange={e => edit(i, { value: Number(e.target.value) })}/>
          </Field>}
        </div>
        <Field label="Kategori pengeluaran terkait">
          <select multiple value={r.category_ids} onChange={e => edit(i, { category_ids: Array.from((e.currentTarget as HTMLSelectElement).selectedOptions).map(o => o.value) })}>
            {data.categories.filter(c => c.kind === "expense").map(c => <option key={c.id} value={c.id}>
              {c.name}
            </option>)}
          </select>
        </Field>
        <Field label="Target terkait">
          <select value={r.goal_id || ""} onChange={e => edit(i, { goal_id: e.target.value || undefined })}>
            <option value="">Tanpa target</option>
            {data.goals.map(g => <option value={g.id} key={g.id}>
              {g.name}
            </option>)}
          </select>
        </Field>
        <label className="check"><input type="checkbox" checked={!!r.rollover} onChange={e => edit(i, { rollover: e.target.checked })}/>Bawa sisa ke siklus berikutnya</label>
        {rules.length > 1 && <button type="button" className="text-btn" onClick={() => setRules(rules.filter((_, j) => j !== i))}><Trash2 size={14}/> Hapus pos</button>}
      </fieldset>)}
      <button type="button" className="btn" onClick={() => setRules([...rules, initial()])}><Plus size={15}/>Tambah pos</button>
      <ErrorNote message={error}/>
      <button className="btn primary" disabled={busy}>Simpan skema</button>
    </form>;
}
type Result = {
    basis: number;
    items: {
        name: string;
        amount: number;
    }[];
    remaining: number;
    revision: string;
    applicable: boolean;
};
export function Allocate({ scheme, data, done }: {
    scheme: Scheme;
    data: Data;
    done: () => void;
}) {
    const [ids, setIds] = useState<string[]>([]), [date, setDate] = useState(today()), [res, setRes] = useState<Result | null>(null), [key, setKey] = useState(""), [err, setErr] = useState(""), [busy, setBusy] = useState(false);
    const incomes = data.transactions.filter(t => t.kind === "income");
    async function run(apply: boolean) { setBusy(true); setErr(""); try {
        const request_id = apply ? key : crypto.randomUUID();
        const r = await post<Result>("/schemes/" + scheme.id + "/" + (apply ? "apply" : "preview"), { income_ids: ids, request_id, date, revision: apply ? res?.revision : undefined });
        if (apply)
            done();
        else {
            setKey(request_id);
            setRes(r);
        }
    }
    catch (e) {
        setErr(e instanceof Error ? e.message : "Gagal memproses pembagian.");
    }
    finally {
        setBusy(false);
    } }
    return <div className="form">
      <Field label="Tanggal penerapan">
        <input type="date" value={date} onChange={e => { setDate(e.target.value); setRes(null); }}/>
      </Field>
      <h3>Pemasukan yang dibagi</h3>
      {incomes.length ? incomes.map(t => <label className="check" key={t.id}><input type="checkbox" checked={ids.includes(t.id)} onChange={e => { setIds(e.target.checked ? [...ids, t.id] : ids.filter(x => x !== t.id)); setRes(null); }}/>{t.description || "Pemasukan"} · {money(t.amount)}</label>) : <p className="muted">Belum ada pemasukan pada bulan pilihan.</p>}
      {res && <div className="paper-totals">
        <div>
          <span>Dana siap dibagi</span>
          <b>
            {money(res.basis)}
          </b>
        </div>
        {res.items.map((x, i) => <div key={i}>
          <span>
            {x.name}
          </span>
          <b>
            {money(x.amount)}
          </b>
        </div>)}
        <div>
          <span>Sisa</span>
          <b>
            {money(res.remaining)}
          </b>
        </div>
      </div>}
      <ErrorNote message={err}/>
      <button disabled={busy || !date || !ids.length || res?.applicable === false} className="btn primary" onClick={() => run(!!res)}>
        {res ? "Terapkan pembagian" : "Pratinjau pembagian"}
      </button>
    </div>;
}
export function Plans({ data, newScheme, newGoal, select }: {
    data: Data;
    newScheme: () => void;
    newGoal: () => void;
    select: (s: Scheme) => void;
}) {
    return <div className="two-cols">
      <section className="card">
        <div className="section-title">
          <h2>Skema keuangan</h2>
          <Layers3 size={18}/>
        </div>
        {data.schemes.length ? data.schemes.map(s => <div key={s.id}>
          <button className="list-action" onClick={() => select(s)}>
            <strong>
              {s.name}
            </strong>
            <small>Siklus tanggal {s.cycle_day} · {s.rules.length} pos · Bagi pemasukan</small>
          </button>
          {s.pots?.map(p => <div key={p.name} className="pot-stats">
            <strong>
              {p.name}
            </strong>
            <small>Dialokasikan {money(p.allocated)} · Terpakai {money(p.used)} · Sisa {money(p.remaining)}</small>
          </div>)}
        </div>) : <p className="empty">Bagi pemasukan ke pos dengan nominal tetap, persentase, atau sisa.</p>}
        <button className="text-btn" onClick={newScheme}><Plus size={15}/>Buat skema</button>
      </section>
      <section className="card">
        <div className="section-title">
          <h2>Target tabungan</h2>
          <Target size={18}/>
        </div>
        {data.goals.length ? data.goals.map(g => <div key={g.id} className="goal-row">
          <h3>
            {g.name}
          </h3>
          <p>{money(g.reserved || 0)} dari {money(g.target)}</p>
          <progress max={g.target} value={g.reserved || 0}/>
        </div>) : <p className="empty">Tautkan target ke pos untuk melihat progresnya.</p>}
        <button className="text-btn" onClick={newGoal}><Plus size={15}/>Buat target</button>
      </section>
    </div>;
}
