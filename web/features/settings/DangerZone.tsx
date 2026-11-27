"use client";
import { useState, type FormEvent } from "react";
import { AlertTriangle, CheckCircle2, RotateCcw, Trash2 } from "lucide-react";
import { ErrorNote, Field, Modal } from "../../components/ui";
import { post } from "../../lib/api";
import type { Data } from "../../lib/domain";

type ResetMode = "partial" | "wipe";

interface ResetResult {
    mode: ResetMode;
    deleted: Record<string, number>;
    zeroed_accounts: number;
}

export function DangerZone({
    data,
    onDone,
}: {
    data: Data;
    onDone: (nextStartDay?: number) => void;
}) {
    const [resetTransactions, setResetTransactions] = useState(true);
    const [clearEvidence, setClearEvidence] = useState(false);
    const [zeroOpeningBalances, setZeroOpeningBalances] = useState(false);
    const [clearBudgets, setClearBudgets] = useState(false);

    const [modalMode, setModalMode] = useState<ResetMode | null>(null);
    const [confirmText, setConfirmText] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [successMsg, setSuccessMsg] = useState("");

    const hasPartialSelection =
        resetTransactions || clearEvidence || zeroOpeningBalances || clearBudgets;

    const expectedPhrase = modalMode === "wipe" ? "WIPE SEMUA" : "RESET";
    const phraseMatches = confirmText.trim().toUpperCase() === expectedPhrase;

    function openModal(mode: ResetMode) {
        setModalMode(mode);
        setConfirmText("");
        setError("");
    }

    function closeModal() {
        if (busy) return;
        setModalMode(null);
        setConfirmText("");
        setError("");
    }

    async function handleExecute(e: FormEvent<HTMLFormElement>) {
        e.preventDefault();
        if (!modalMode || !phraseMatches) return;
        setBusy(true);
        setError("");
        setSuccessMsg("");
        try {
            const res = await post<ResetResult>("/data/reset", {
                mode: modalMode,
                confirm: confirmText.trim(),
                reset_transactions: modalMode === "partial" ? resetTransactions : false,
                clear_evidence: modalMode === "partial" ? clearEvidence : false,
                zero_opening_balances: modalMode === "partial" ? zeroOpeningBalances : false,
                clear_budgets: modalMode === "partial" ? clearBudgets : false,
            });
            setModalMode(null);
            setConfirmText("");
            if (res.mode === "wipe") {
                setSuccessMsg("Seluruh data berhasil dihapus. Aplikasi kembali ke kondisi kosong.");
                onDone(1);
            } else {
                const parts: string[] = [];
                if (resetTransactions) parts.push(`${res.deleted.transactions ?? 0} transaksi`);
                if (clearEvidence) parts.push(`${res.deleted.evidence ?? 0} bukti`);
                if (zeroOpeningBalances) parts.push(`${res.zeroed_accounts ?? 0} saldo awal dompet di-nol-kan`);
                if (clearBudgets) parts.push(`${res.deleted.budgets ?? 0} anggaran`);
                setSuccessMsg(`Reset selesai: ${parts.join(", ")}.`);
                onDone();
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : "Gagal menjalankan reset data.");
        } finally {
            setBusy(false);
        }
    }

    const totalAccounts = data.accounts.length;
    const totalCategories = data.categories.length;
    const totalBudgets = data.budgets?.length ?? 0;
    const totalReviews = data.reviews?.length ?? 0;

    return (
        <section className="card" style={{ borderColor: "var(--danger, #dc2626)" }}>
            <div className="section-title">
                <h2 style={{ color: "var(--danger, #dc2626)" }}>Zona Bahaya (Reset &amp; Hapus Data)</h2>
                <AlertTriangle size={18} style={{ color: "var(--danger, #dc2626)" }} />
            </div>

            {successMsg && (
                <div className="success" style={{ marginBottom: 12 }}>
                    <CheckCircle2 size={17} />
                    <span>{successMsg}</span>
                </div>
            )}

            <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
                Pilih data yang ingin direset secara selektif tanpa menghapus master dompet &amp; kategori, atau hapus
                seluruh data untuk memulai benar-benar dari nol. Tindakan ini bersifat permanen.
            </p>

            <div className="stack" style={{ gap: 8, marginBottom: 14 }}>
                <label className="paper-line" style={{ cursor: "pointer", gap: 10 }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <input
                            type="checkbox"
                            checked={resetTransactions}
                            onChange={e => setResetTransactions(e.target.checked)}
                        />
                        <span>Transaksi &amp; mutasi saldo (termasuk cadangan)</span>
                    </span>
                </label>
                <label className="paper-line" style={{ cursor: "pointer", gap: 10 }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <input
                            type="checkbox"
                            checked={clearEvidence}
                            onChange={e => setClearEvidence(e.target.checked)}
                        />
                        <span>Antrean bukti/review ({totalReviews}) &amp; riwayat impor</span>
                    </span>
                </label>
                <label className="paper-line" style={{ cursor: "pointer", gap: 10 }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <input
                            type="checkbox"
                            checked={zeroOpeningBalances}
                            onChange={e => setZeroOpeningBalances(e.target.checked)}
                        />
                        <span>Nol-kan saldo awal dompet ({totalAccounts} dompet → Rp0)</span>
                    </span>
                </label>
                <label className="paper-line" style={{ cursor: "pointer", gap: 10 }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <input
                            type="checkbox"
                            checked={clearBudgets}
                            onChange={e => setClearBudgets(e.target.checked)}
                        />
                        <span>Anggaran bulanan ({totalBudgets})</span>
                    </span>
                </label>
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                <button
                    type="button"
                    className="btn"
                    disabled={!hasPartialSelection}
                    onClick={() => openModal("partial")}
                >
                    <RotateCcw size={15} /> Reset data terpilih…
                </button>
                <button
                    type="button"
                    className="btn danger"
                    onClick={() => openModal("wipe")}
                >
                    <Trash2 size={15} /> Wipe semua data…
                </button>
            </div>

            {modalMode && (
                <Modal
                    title={modalMode === "wipe" ? "Konfirmasi Wipe Semua Data" : "Konfirmasi Reset Data"}
                    onClose={closeModal}
                >
                    <form className="form" onSubmit={handleExecute}>
                        <p style={{ fontSize: 13 }}>
                            {modalMode === "wipe" ? (
                                <>
                                    Tindakan ini akan <b>menghapus permanen seluruh data</b> Anda: semua transaksi,{" "}
                                    <b>{totalAccounts} dompet</b>, <b>{totalCategories} kategori</b>,{" "}
                                    <b>{totalBudgets} anggaran</b>, <b>{totalReviews} antrean bukti</b>, merchant,
                                    skema, target, dan mengembalikan pengaturan ke default.
                                </>
                            ) : (
                                <>Tindakan ini bersifat permanen untuk item yang Anda pilih:</>
                            )}
                        </p>

                        {modalMode === "partial" && (
                            <ul style={{ margin: "4px 0 8px 18px", fontSize: 13, lineHeight: 1.6 }}>
                                {resetTransactions && <li>Seluruh riwayat transaksi, mutasi saldo, &amp; cadangan</li>}
                                {clearEvidence && (
                                    <li>Antrean bukti/review ({totalReviews}) &amp; riwayat impor Excel/struk</li>
                                )}
                                {zeroOpeningBalances && (
                                    <li>Saldo awal seluruh dompet ({totalAccounts} dompet) menjadi Rp0</li>
                                )}
                                {clearBudgets && <li>Seluruh anggaran bulanan ({totalBudgets})</li>}
                            </ul>
                        )}

                        <Field label={`Ketik "${expectedPhrase}" untuk konfirmasi`}>
                            <input
                                type="text"
                                value={confirmText}
                                onChange={e => setConfirmText(e.target.value)}
                                placeholder={expectedPhrase}
                                autoComplete="off"
                                autoFocus
                            />
                        </Field>

                        <ErrorNote message={error} />

                        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                            <button type="button" className="btn" onClick={closeModal} disabled={busy}>
                                Batal
                            </button>
                            <button
                                type="submit"
                                className="btn danger"
                                disabled={!phraseMatches || busy}
                            >
                                {busy
                                    ? "Memproses…"
                                    : modalMode === "wipe"
                                      ? "Wipe Semua Data"
                                      : "Jalankan Reset"}
                            </button>
                        </div>
                    </form>
                </Modal>
            )}
        </section>
    );
}
