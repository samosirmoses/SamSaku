"use client";
import { Plus, Trash2 } from "lucide-react";
import { type Transaction, kindLabels, money } from "../../lib/domain";

export function EntryFormFooter({
    isEdit,
    kind,
    numAmount,
    txAmount,
    busy,
    scanning,
    canKeepOpen,
    confirmDelete,
    onKeepOpenClick,
    onRequestDelete,
    onCancelDelete,
    onConfirmDelete,
}: {
    isEdit: boolean;
    kind: Transaction["kind"];
    numAmount: number;
    txAmount?: number;
    busy: boolean;
    scanning: boolean;
    canKeepOpen: boolean;
    confirmDelete: boolean;
    onKeepOpenClick: () => void;
    onRequestDelete: () => void;
    onCancelDelete: () => void;
    onConfirmDelete: () => void;
}) {
    return (
        <>
            <div className="entry-sticky-footer">
                <button type="submit" disabled={busy || scanning} className="btn primary entry-submit-main">
                    {busy
                        ? "Menyimpan…"
                        : isEdit
                          ? "Simpan perubahan"
                          : `Simpan ${kindLabels[kind]}${numAmount > 0 ? ` · ${money(numAmount)}` : ""}`}
                </button>
                {canKeepOpen && (
                    <button
                        type="submit"
                        disabled={busy || scanning}
                        className="btn"
                        title="Simpan lalu langsung catat transaksi berikutnya"
                        onClick={onKeepOpenClick}
                    >
                        <Plus size={15} /> Simpan &amp; Lagi
                    </button>
                )}
                {isEdit && !confirmDelete && (
                    <button type="button" className="btn danger-outline" disabled={busy} onClick={onRequestDelete}>
                        <Trash2 size={15} /> Hapus
                    </button>
                )}
            </div>

            {isEdit && confirmDelete && (
                <div className="danger-box">
                    <strong>Hapus transaksi ini ({money(txAmount || 0)})?</strong>
                    <p className="muted">Saldo dompet dan perhitungan laporan akan otomatis diperbarui.</p>
                    <div className="btns">
                        <button type="button" className="btn danger" disabled={busy} onClick={onConfirmDelete}>
                            Ya, hapus
                        </button>
                        <button type="button" className="btn" disabled={busy} onClick={onCancelDelete}>
                            Batal
                        </button>
                    </div>
                </div>
            )}
        </>
    );
}
