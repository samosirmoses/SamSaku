"use client";
import { useState, type FormEvent } from "react";
import { Plus, Target, Trash2 } from "lucide-react";
import { ErrorNote, Field } from "../../components/ui";
import { del, post } from "../../lib/api";
import { type Goal, formatDots, money, parseDigits } from "../../lib/domain";

export function GoalsPanel({ goals, onDone }: { goals: Goal[]; onDone: () => void }) {
    const [name, setName] = useState("");
    const [target, setTarget] = useState("");
    const [targetDate, setTargetDate] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    async function addGoal(e: FormEvent<HTMLFormElement>) {
        e.preventDefault();
        const num = parseDigits(target);
        if (!name.trim() || num <= 0) {
            setError("Isi nama tujuan dan target nominal tabungan.");
            return;
        }
        setBusy(true);
        setError("");
        try {
            await post("/goals", {
                name: name.trim(),
                target: num,
                target_date: targetDate || null,
            });
            setName("");
            setTarget("");
            setTargetDate("");
            onDone();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Gagal menambah tujuan.");
        } finally {
            setBusy(false);
        }
    }

    async function removeGoal(goal: Goal) {
        setBusy(true);
        setError("");
        try {
            await del("/goals/" + goal.id);
            onDone();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Gagal menghapus tujuan.");
        } finally {
            setBusy(false);
        }
    }

    return (
        <section className="card">
            <div className="section-title">
                <h2>Target &amp; Amplop Tabungan</h2>
                <Target size={18} />
            </div>
            {goals.length ? (
                <div className="budget-list" style={{ marginBottom: 14 }}>
                    {goals.map(g => {
                        const pct = g.target > 0 ? Math.min(100, Math.round((100 * g.reserved) / g.target)) : 0;
                        return (
                            <div key={g.id} className="budget-card-row">
                                <div className="budget-row-top">
                                    <div>
                                        <strong>{g.name}</strong>
                                        <small className="muted" style={{ display: "block" }}>
                                            Terkumpul {money(g.reserved)} dari {money(g.target)} ({pct}%)
                                            {g.target_date ? ` · Target ${g.target_date}` : ""}
                                        </small>
                                    </div>
                                    <button
                                        type="button"
                                        className="icon-btn"
                                        title={`Hapus target ${g.name}`}
                                        disabled={busy}
                                        onClick={() => removeGoal(g)}
                                    >
                                        <Trash2 size={15} />
                                    </button>
                                </div>
                                <div className="bar-line">
                                    <span className="bar-track" style={{ height: 8 }}>
                                        <span className="bar bar-safe" style={{ width: Math.max(2, pct) + "%" }} />
                                    </span>
                                </div>
                            </div>
                        );
                    })}
                </div>
            ) : (
                <p className="empty" style={{ marginBottom: 12 }}>
                    Belum ada target tabungan. Buat amplop target untuk dana darurat atau rencana belanja besar.
                </p>
            )}

            <form className="form" onSubmit={addGoal}>
                <div className="form-pair">
                    <Field label="Nama target tabungan">
                        <input
                            value={name}
                            onChange={e => setName(e.target.value)}
                            placeholder="Contoh: Dana Darurat"
                            required
                        />
                    </Field>
                    <Field label="Nominal target (Rp)">
                        <input
                            type="text"
                            inputMode="numeric"
                            value={formatDots(target)}
                            onChange={e => setTarget(e.target.value.replace(/\D/g, ""))}
                            placeholder="5.000.000"
                            required
                        />
                    </Field>
                </div>
                <Field label="Tanggal target (opsional)">
                    <input type="date" value={targetDate} onChange={e => setTargetDate(e.target.value)} />
                </Field>
                <ErrorNote message={error} />
                <button type="submit" className="btn sm" disabled={busy} style={{ justifySelf: "start" }}>
                    <Plus size={14} /> {busy ? "Menyimpan…" : "Tambah Target"}
                </button>
            </form>
        </section>
    );
}
