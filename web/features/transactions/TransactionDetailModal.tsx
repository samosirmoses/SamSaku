"use client";
import { useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { del } from "../../lib/api";
import { type Data, type Transaction, kindLabels, money } from "../../lib/domain";

export function TransactionDetailModal({
    doc,
    data,
    onEdit,
    onDeleted,
    onError,
}: {
    doc: Transaction;
    data: Data;
    onEdit: () => void;
    onDeleted: () => void;
    onError: (msg: string) => void;
}) {
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [deleting, setDeleting] = useState(false);

    async function deleteCurrentTx() {
        setDeleting(true);
        try {
            await del("/transactions/" + doc.id);
            onDeleted();
        } catch (e) {
            onError(e instanceof Error ? e.message : "Gagal menghapus transaksi.");
        } finally {
            setDeleting(false);
        }
    }

    return (
        <div className="detail">
            <div
                className={
                    "detail-amount " +
                    (doc.kind === "income" || doc.kind === "refund"
                        ? "income"
                        : doc.kind === "transfer"
                          ? "transfer-amt"
                          : "expense-amt")
                }
            >
                {doc.kind === "income" || doc.kind === "refund" ? "+" : doc.kind === "transfer" ? "⇄ " : "−"}
                {money(doc.amount)}
            </div>
            <h3>{doc.description || kindLabels[doc.kind]}</h3>
            {[
                ["Tanggal", doc.date],
                ["Jenis", kindLabels[doc.kind]],
                [
                    doc.kind === "transfer" ? "Dompet asal" : "Dompet",
                    doc.account_name || data.accounts.find(a => a.id === doc.account_id)?.name,
                ],
                [
                    "Dompet tujuan",
                    doc.to_account_name || data.accounts.find(a => a.id === doc.to_account_id)?.name,
                ],
                [
                    "Kategori",
                    doc.category_name || data.categories.find(c => c.id === doc.category_id)?.name,
                ],
                ["Biaya admin", doc.fee ? money(doc.fee) : null],
                ["Sumber", doc.source],
            ].map(([key, val]) =>
                val ? (
                    <div className="paper-line" key={key}>
                        <span>{key}</span>
                        <b>{val}</b>
                    </div>
                ) : null
            )}

            {doc.splits && doc.splits.filter(s => s.role !== "fee").length > 1 && (
                <div className="split-detail-box">
                    <strong>Rincian Split Kategori</strong>
                    {doc.splits
                        .filter(s => s.role !== "fee")
                        .map((s, idx) => {
                            const cName =
                                s.category_name ||
                                data.categories.find(c => c.id === s.category_id)?.name ||
                                "Belum dikategorikan";
                            return (
                                <div className="paper-line" key={idx}>
                                    <span>{cName}</span>
                                    <b>{money(Math.abs(s.amount))}</b>
                                </div>
                            );
                        })}
                </div>
            )}

            <div className="btns" style={{ marginTop: 18 }}>
                <button type="button" className="btn primary" onClick={onEdit}>
                    <Pencil size={15} /> Ubah transaksi
                </button>
                {!confirmDelete && (
                    <button
                        type="button"
                        className="btn danger-outline"
                        onClick={() => setConfirmDelete(true)}
                    >
                        <Trash2 size={15} /> Hapus
                    </button>
                )}
            </div>

            {confirmDelete && (
                <div className="danger-box" style={{ marginTop: 14 }}>
                    <strong>Hapus transaksi ini?</strong>
                    <p className="muted">Tindakan ini akan menghapus transaksi dan memperbarui saldo dompet.</p>
                    <div className="btns">
                        <button
                            type="button"
                            className="btn danger"
                            disabled={deleting}
                            onClick={deleteCurrentTx}
                        >
                            {deleting ? "Menghapus…" : "Ya, hapus"}
                        </button>
                        <button type="button" className="btn" onClick={() => setConfirmDelete(false)}>
                            Batal
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
