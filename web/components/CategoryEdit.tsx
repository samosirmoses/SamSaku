"use client";
import { useState, type FormEvent } from "react";
import { request } from "../lib/api";
import type { Category } from "../lib/domain";
import { ErrorNote, Field } from "./ui";

export function CategoryEdit({ category, done }: {category: Category; done: () => void}) {
    const [name, setName] = useState(category.name);
    const [archived, setArchived] = useState(!!category.archived);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setBusy(true);
        setError("");
        try {
            await request("/categories/" + category.id, {
                method: "PATCH",
                body: JSON.stringify({name: name.trim(), archived})
            });
            done();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Gagal memperbarui kategori.");
        } finally {
            setBusy(false);
        }
    }
    return (
        <form onSubmit={submit} className="form">
            <Field label="Nama kategori"><input value={name} required maxLength={160} onChange={event => setName(event.target.value)} /></Field>
            <label className="check"><input type="checkbox" checked={archived} onChange={event => setArchived(event.target.checked)} />Arsipkan untuk transaksi berikutnya</label>
            <ErrorNote message={error}/>
            <button className="btn primary" disabled={busy}>Simpan perubahan</button>
        </form>
    );
}

