"use client";
import { useState } from "react";
import { request, post } from "../lib/api";
import { Data, money } from "../lib/domain";
import { EntryForm } from "./Entries";
import { Field, ErrorNote } from "./ui";
type OCR = {
    id: string;
    status: string;
    merchant?: string;
    amount?: number;
    date?: string;
    candidates?: {
        id: string;
        date: string;
        amount: number;
        description: string;
    }[];
};
export function Receipt({ data, done }: {
    data: Data;
    done: () => void;
}) {
    const [file, setFile] = useState<File | null>(null), [result, setResult] = useState<OCR | null>(null), [job, setJob] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false), [link, setLink] = useState("");
    async function read() { setBusy(true); setError(""); try {
        let id = job;
        if (!id) {
            if (!file)
                return;
            const f = new FormData();
            f.append("file", file);
            const r = await request("/receipts", { method: "POST", body: f }) as OCR;
            id = r.id;
            setJob(id);
        }
        setResult(await post<OCR>("/receipts/" + id + "/process", {}));
    }
    catch (e) {
        setError(e instanceof Error ? e.message : "Gagal membaca struk.");
    }
    finally {
        setBusy(false);
    } }
    async function attach() { setBusy(true); setError(""); try {
        await post("/receipts/" + job + "/confirm", { transaction_id: link });
        done();
    }
    catch (e) {
        setError(e instanceof Error ? e.message : "Gagal menautkan bukti.");
    }
    finally {
        setBusy(false);
    } }
    return <div className="form">
      {!result ? <>
        <Field label="Foto struk">
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={e => { setFile(e.target.files?.[0] || null); setJob(""); }}/>
        </Field>
        <button className="btn primary" onClick={read} disabled={!file || busy}>
          {busy ? "Membaca foto…" : "Baca struk"}
        </button>
      </> : <>
        <p>{result.merchant || "Merchant belum terbaca"} · {result.amount ? money(result.amount) : "Periksa nominal"}</p>
        {result.candidates?.length ? <div>
          <h3>Kemungkinan transaksi yang sama</h3>
          {result.candidates.map(t => <button className="list-action" key={t.id} onClick={() => setLink(t.id)}>{t.date} · {t.description} · {money(t.amount)}</button>)}
        </div> : null}
        <Field label="Tautkan ke transaksi yang sudah ada">
          <select value={link} onChange={e => setLink(e.target.value)}>
            <option value="">Pilih transaksi</option>
            {(result.candidates || []).filter(t => !data.transactions.some(d => d.id === t.id)).map(t => <option key={t.id} value={t.id}>{t.date} · {t.description} · {money(t.amount)}</option>)}
            {data.transactions.map(t => <option key={t.id} value={t.id}>{t.date} · {t.description} · {money(t.amount)}</option>)}
          </select>
        </Field>
        <button className="btn" disabled={!link || busy} onClick={attach}>Tautkan bukti</button>
        <details>
          <summary>Catat sebagai transaksi baru</summary>
          <EntryForm data={data} initial={{ description: result.merchant, amount: result.amount, date: result.date }} onDone={done} submitPath={"/receipts/" + job + "/confirm"} wrap={transaction => ({ transaction })}/>
        </details>
      </>}
      <ErrorNote message={error}/>
    </div>;
}
