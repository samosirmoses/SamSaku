"use client";
import { useState } from "react";
import { ErrorNote, Field } from "../../components/ui";
import { post } from "../../lib/api";
import { type Data, type Review, money } from "../../lib/domain";
import { EntryForm } from "../transactions/EntryForm";

export function ReviewModal({ r, data, done }: { r: Review; data: Data; done: () => void }) {
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
