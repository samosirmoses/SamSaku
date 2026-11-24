"use client";
import { useState, type FormEvent } from "react";
import { Trash2 } from "lucide-react";
import { del, patch } from "../lib/api";
import type { Category } from "../lib/domain";
import { ErrorNote, Field } from "./ui";

export function CategoryEdit({
    category,
    categories = [],
    done,
}: {
    category: Category;
    categories?: Category[];
    done: () => void;
}) {
    const [name, setName] = useState(category.name);
    const [parentId, setParentId] = useState(category.parent_id || "");
    const [archived, setArchived] = useState(!!category.archived);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [transferTo, setTransferTo] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const parentCandidates = categories.filter(
        c => c.kind === category.kind && c.id !== category.id && !c.parent_id && !c.archived
    );
    const siblingCandidates = categories.filter(c => c.kind === category.kind && c.id !== category.id);

    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setBusy(true);
        setError("");
        try {
            await patch("/categories/" + category.id, {
                name: name.trim(),
                parent_id: parentId || null,
                archived,
            });
            done();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Gagal memperbarui kategori.");
        } finally {
            setBusy(false);
        }
    }

    async function removeCategory() {
        setBusy(true);
        setError("");
        try {
            const qs = transferTo ? `?transfer_to=${encodeURIComponent(transferTo)}` : "";
            await del("/categories/" + category.id + qs);
            done();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Gagal menghapus kategori.");
        } finally {
            setBusy(false);
        }
    }

    return (
        <form onSubmit={submit} className="form">
            <Field label="Nama kategori">
                <input
                    value={name}
                    required
                    maxLength={160}
                    onChange={event => setName(event.target.value)}
                />
            </Field>
            {parentCandidates.length > 0 && (
                <Field label="Kategori induk">
                    <select value={parentId} onChange={e => setParentId(e.target.value)}>
                        <option value="">Tanpa induk (Kategori utama)</option>
                        {parentCandidates.map(c => (
                            <option key={c.id} value={c.id}>
                                {c.name}
                            </option>
                        ))}
                    </select>
                </Field>
            )}
            <label className="check">
                <input
                    type="checkbox"
                    checked={archived}
                    onChange={event => setArchived(event.target.checked)}
                />
                Arsipkan untuk transaksi berikutnya
            </label>
            <ErrorNote message={error} />
            <div className="btns">
                <button type="submit" className="btn primary" disabled={busy}>
                    Simpan perubahan
                </button>
                {!confirmDelete && (
                    <button
                        type="button"
                        className="btn danger-outline"
                        disabled={busy}
                        onClick={() => setConfirmDelete(true)}
                    >
                        <Trash2 size={15} /> Hapus kategori
                    </button>
                )}
            </div>

            {confirmDelete && (
                <div className="danger-box">
                    <strong>Hapus kategori &ldquo;{category.name}&rdquo;?</strong>
                    <Field label="Alihkan transaksi pada kategori ini ke">
                        <select value={transferTo} onChange={e => setTransferTo(e.target.value)}>
                            <option value="">Jadikan Belum dikategorikan</option>
                            {siblingCandidates.map(c => (
                                <option key={c.id} value={c.id}>
                                    {c.name}
                                </option>
                            ))}
                        </select>
                    </Field>
                    <div className="btns">
                        <button type="button" className="btn danger" disabled={busy} onClick={removeCategory}>
                            Ya, hapus kategori
                        </button>
                        <button
                            type="button"
                            className="btn"
                            disabled={busy}
                            onClick={() => setConfirmDelete(false)}
                        >
                            Batal
                        </button>
                    </div>
                </div>
            )}
        </form>
    );
}
