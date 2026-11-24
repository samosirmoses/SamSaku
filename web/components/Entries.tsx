"use client";
import { useState, useEffect, useRef, type FormEvent } from "react";
import { get, post } from "../lib/api";
import { type Data, type Transaction, kindLabels, today, money } from "../lib/domain";
import { ErrorNote, Field } from "./ui";
const err = (e: unknown) => e instanceof Error ? e.message : "Gagal menyimpan perubahan.";
export function MasterForm({ mode, data, onDone }: {
    mode: "account" | "category" | "goal";
    data: Data;
    onDone: () => void;
}) {
    const [error, setError] = useState(""), [busy, setBusy] = useState(false), [kind, setKind] = useState("expense");
    async function submit(e: FormEvent<HTMLFormElement>) {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        setBusy(true);
        setError("");
        const name = String(f.get("name")).trim();
        try {
            const code = String(f.get("code") || name).trim().toUpperCase().replace(/[^A-Z0-9_-]+/g, "-").slice(0, 48) || "ITEM";
            if (mode === "category")
                await post("/categories", { code, name, kind, parent_id: f.get("parent_id") || null });
            if (mode === "account")
                await post("/accounts", { code, name, kind: f.get("account_kind"), opening_date: f.get("opening_date") || null, opening_balance: f.get("opening_balance") !== "" ? Number(f.get("opening_balance")) : null });
            if (mode === "goal")
                await post("/goals", { name, target: Number(f.get("target")) });
            onDone();
        }
        catch (e) {
            setError(err(e));
        }
        finally {
            setBusy(false);
        }
    }
    return <form onSubmit={submit} className="form">
      <Field label="Nama">
        <input autoFocus name="name" required maxLength={90}/>
      </Field>
 
      {mode !== "goal" && <Field label="Kode master (opsional)">
        <input name="code" placeholder="Otomatis dari nama"/>
      </Field>}
 
      {mode === "category" && <>
        <Field label="Jenis">
          <select value={kind} onChange={e => setKind(e.target.value)}>
            <option value="expense">Pengeluaran</option>
            <option value="income">Pemasukan</option>
          </select>
        </Field>
        <Field label="Kategori induk">
          <select name="parent_id" key={kind}>
            <option value="">Tanpa induk</option>
            {data.categories.filter(c => c.kind === kind && !c.archived && !c.parent_id).map(c => <option key={c.id} value={c.id}>
              {c.name}
            </option>)}
          </select>
        </Field>
      </>}
 
      {mode === "account" && <>
        <Field label="Jenis dompet">
          <select name="account_kind">
            <option value="bank">Rekening bank</option>
            <option value="ewallet">Dompet digital</option>
            <option value="cash">Tunai</option>
          </select>
        </Field>
        <Field label="Saldo awal (Rp, opsional)">
          <input type="number" name="opening_balance" step="1"/>
        </Field>
        <Field label="Tanggal saldo awal">
          <input type="date" name="opening_date"/>
        </Field>
      </>}
 
      {mode === "goal" && <Field label="Target (Rp)">
        <input name="target" type="number" step="1" min="1" required/>
      </Field>}
      <ErrorNote message={error}/>
      <button className="btn primary" disabled={busy}>
        {busy ? "Menyimpan…" : "Simpan"}
      </button>
    </form>;
}
export function EntryForm({ data, onDone, submitPath, wrap, initial = {} }: {
    data: Data;
    onDone: () => void;
    submitPath?: string;
    wrap?: (t: Record<string, unknown>) => unknown;
    initial?: {
        description?: string;
        amount?: number;
        date?: string;
        kind?: Transaction["kind"];
        account_id?: string;
    };
}) {
    const [kind, setKind] = useState<Transaction["kind"]>(initial.kind || "expense"), [error, setError] = useState(""), [busy, setBusy] = useState(false), [split, setSplit] = useState(false);
    const [catId, setCatId] = useState(""), [categories, setCategories] = useState(data.categories), [inline, setInline] = useState(false), [newName, setNewName] = useState("");
    const [expenses, setExpenses] = useState(data.transactions.filter(t => t.kind === "expense"));
    const sourceRef = useRef("");
    useEffect(() => { let active = true; if (kind === "refund") {
        get<Transaction[]>("/transactions").then(rows => { if (active)
            setExpenses(rows.filter(t => t.kind === "expense")); }).catch(e => { if (active)
            setError(err(e)); });
    } return () => { active = false; }; }, [kind]);
    const cats = categories.filter(c => !c.archived && c.kind === (kind === "income" ? "income" : "expense"));
    async function addCategory() { const name = newName.trim(); if (!name)
        return; setBusy(true); setError(""); try {
        const c = await post<Data["categories"][number]>("/categories", { name, code: name.toUpperCase().replace(/[^A-Z0-9]+/g, "-") || "CAT", kind: kind === "income" ? "income" : "expense" });
        setCategories(v => [...v, c]);
        setCatId(c.id);
        setInline(false);
        setNewName("");
    }
    catch (e) {
        setError(err(e));
    }
    finally {
        setBusy(false);
    } }
    async function submit(e: FormEvent<HTMLFormElement>) {
        e.preventDefault();
        const f = new FormData(e.currentTarget), amount = Number(f.get("amount"));
        if (!sourceRef.current)
            sourceRef.current = crypto.randomUUID();
        let payload: Record<string, unknown> = { source_ref: submitPath ? undefined : sourceRef.current, kind, date: f.get("date"), description: f.get("description"), account_id: f.get("account_id"), amount, category_id: catId || null };
        setError("");
        if (split && kind !== "transfer" && kind !== "refund") {
            const a = Number(f.get("split_amount")), b = String(f.get("split_cat"));
            if (!catId || !b || catId === b || a <= 0 || a >= amount) {
                setError("Pilih dua kategori berbeda dan nominal bagian pertama di antara nol dan total.");
                return;
            }
            payload = { ...payload, category_id: null, splits: [{ category_id: catId, amount: a }, { category_id: b, amount: amount - a }] };
        }
        if (kind === "transfer") {
            payload.to_account_id = f.get("to_account_id");
            payload.fee = Number(f.get("fee") || 0);
            if (payload.to_account_id === payload.account_id) {
                setError("Pilih dua dompet berbeda.");
                return;
            }
        }
        if (kind === "refund")
            payload.original_id = f.get("original_id");
        setBusy(true);
        try {
            await post(submitPath || "/transactions", wrap ? wrap(payload) : payload);
            onDone();
        }
        catch (e) {
            setError(err(e));
        }
        finally {
            setBusy(false);
        }
    }
    if (!data.accounts.length)
        return <p className="empty">Buat dompet di Master data terlebih dahulu.</p>;
    return <form className="form" onSubmit={submit}>
      <Field label="Jenis transaksi">
        <select value={kind} onChange={e => { setKind(e.target.value as Transaction["kind"]); setCatId(""); setSplit(false); }}>
          {Object.entries(kindLabels).map(([v, k]) => <option value={v} key={v}>
            {k}
          </option>)}
        </select>
      </Field>
      <div className="form-pair">
        <Field label="Nominal (Rp)">
          <input type="number" name="amount" defaultValue={initial.amount} min="1" step="1" required/>
        </Field>
        <Field label="Tanggal">
          <input type="date" name="date" defaultValue={initial.date || today()} required/>
        </Field>
      </div>
      <Field label="Keterangan">
        <input name="description" defaultValue={initial.description} placeholder="Misalnya kopi sore"/>
      </Field>
      <Field label={kind === "transfer" ? "Dompet asal" : "Dompet"}>
        <select name="account_id" required defaultValue={initial.account_id}>
          {data.accounts.map(a => <option key={a.id} value={a.id}>
            {a.name}
          </option>)}
        </select>
      </Field>
 
      {kind === "transfer" ? <>
        <Field label="Dompet tujuan">
          <select name="to_account_id" required defaultValue={data.accounts[1]?.id}>
            {data.accounts.map(a => <option key={a.id} value={a.id}>
              {a.name}
            </option>)}
          </select>
        </Field>
        <Field label="Biaya admin (Rp)">
          <input type="number" min="0" name="fee" defaultValue={0}/>
        </Field>
      </> : kind === "refund" ? <Field label="Transaksi asal">
        <select name="original_id" required>
          <option value="">Pilih pengeluaran</option>
          {expenses.map(t => <option key={t.id} value={t.id}>{t.date} · {t.description} · {money(t.amount)}</option>)}
        </select>
      </Field> : <>
        <Field label="Kategori">
          <select value={catId} onChange={e => setCatId(e.target.value)}>
            <option value="">Belum dikategorikan</option>
            {cats.map(c => <option key={c.id} value={c.id}>
              {c.name}
            </option>)}
          </select>
        </Field>
 
        {inline ? <div className="inline-add">
          <input aria-label="Nama kategori baru" value={newName} onChange={e => setNewName(e.target.value)} placeholder="Nama kategori"/>
          <button className="btn" type="button" disabled={busy} onClick={addCategory}>Buat</button>
        </div> : <button type="button" className="text-btn" onClick={() => setInline(true)}>+ Buat kategori</button>}
        <label className="check"><input type="checkbox" checked={split} onChange={e => setSplit(e.target.checked)}/>Bagi ke dua kategori</label>
        {split && <>
          <Field label="Nominal kategori pertama">
            <input type="number" name="split_amount" min="1" required/>
          </Field>
          <Field label="Kategori untuk sisa nominal">
            <select name="split_cat" required>
              <option value="">Pilih kategori</option>
              {cats.filter(c => c.id !== catId).map(c => <option key={c.id} value={c.id}>
                {c.name}
              </option>)}
            </select>
          </Field>
        </>}
      </>}
      <ErrorNote message={error}/>
      <button type="submit" disabled={busy} className="btn primary">
        {busy ? "Menyimpan…" : "Simpan transaksi"}
      </button>
    </form>;
}
