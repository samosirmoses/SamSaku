"use client";
import { useState } from "react";
import { Check, Inbox, Pencil, X } from "lucide-react";
import { ErrorNote } from "../../components/ui";
import { post } from "../../lib/api";
import { type Data, type Review, kindLabels, money, shortDate } from "../../lib/domain";
import { buildQuickReviewPayload, sourceLabel } from "./PendingDraftsBanner";

export function ReviewsView({
    data,
    reviews,
    highlightIds,
    onSelect,
    onResolved,
}: {
    data: Data;
    reviews: Review[];
    highlightIds?: Set<string>;
    onSelect: (r: Review) => void;
    onResolved: (msg: string) => void;
}) {
    const [busyId, setBusyId] = useState<string | null>(null);
    const [error, setError] = useState("");

    async function resolveQuick(r: Review, action: "post" | "ignore") {
        const quickPayload = action === "post" ? buildQuickReviewPayload(r, data) : null;
        setBusyId(r.id);
        setError("");
        try {
            if (action === "post" && quickPayload) {
                await post(`/reviews/${r.id}/resolve`, { action: "post", transaction: quickPayload });
                onResolved("Draf berhasil disimpan sebagai transaksi.");
            } else {
                await post(`/reviews/${r.id}/resolve`, { action: "ignore" });
                onResolved("Bukti diabaikan.");
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : "Gagal memproses bukti.");
        } finally {
            setBusyId(null);
        }
    }

    return (
        <section className="card">
            <div className="section-title">
                <div>
                    <h2>Antrean Tinjauan Bukti &amp; Draf</h2>
                    <small className="muted">
                        Pesan dari Telegram, myBCA, atau GoPay yang menunggu persetujuan sebelum masuk ke Buku Kas.
                    </small>
                </div>
                <Inbox size={18} />
            </div>

            <ErrorNote message={error} />

            {reviews.length ? (
                <div className="review-cards-stack">
                    {reviews.map(r => {
                        const quickPayload = buildQuickReviewPayload(r, data);
                        const p = r.parsed;
                        const pKind = p?.kind || "expense";
                        const acc = data.accounts.find(
                            a => a.id === ((quickPayload?.account_id as string) || p?.account_id)
                        );
                        const toAcc = p?.to_account_id ? data.accounts.find(a => a.id === p.to_account_id) : null;
                        const cat = p?.category_id ? data.categories.find(c => c.id === p.category_id) : null;
                        const isFresh = highlightIds?.has(r.id);

                        return (
                            <div key={r.id} className={"review-item-card" + (isFresh ? " pulse-new" : "")}>
                                <div className="review-item-top">
                                    <div className="review-source-row">
                                        <span className="review-source-badge">{sourceLabel(r.source)}</span>
                                        {p?.kind && <span className="muted">{kindLabels[pKind]}</span>}
                                        {r.occurred_at && (
                                            <small className="muted">
                                                ·{" "}
                                                {new Date(r.occurred_at).toLocaleString("id-ID", {
                                                    day: "numeric",
                                                    month: "short",
                                                    hour: "2-digit",
                                                    minute: "2-digit",
                                                    timeZone: "Asia/Jakarta",
                                                })}
                                            </small>
                                        )}
                                    </div>
                                    {p?.amount ? (
                                        <strong
                                            className={
                                                pKind === "income"
                                                    ? "income"
                                                    : pKind === "transfer"
                                                      ? "transfer-amt"
                                                      : "expense-amt"
                                            }
                                        >
                                            {pKind === "income" ? "+" : pKind === "transfer" ? "⇄ " : "−"}
                                            {money(p.amount)}
                                        </strong>
                                    ) : (
                                        <small className="muted">Nominal perlu dicek</small>
                                    )}
                                </div>

                                <p className="review-item-text">{r.text}</p>

                                {(acc || cat || p?.date) && (
                                    <div className="review-parsed-tags">
                                        {acc && (
                                            <span className="tx-split-pill">
                                                Dompet: {pKind === "transfer" && toAcc ? `${acc.name} → ${toAcc.name}` : acc.name}
                                            </span>
                                        )}
                                        {cat && <span className="tx-split-pill">Kategori: {cat.name}</span>}
                                        {p?.date && <span className="tx-split-pill">Tgl: {shortDate(p.date)}</span>}
                                    </div>
                                )}

                                <div className="review-item-actions">
                                    {quickPayload && (
                                        <button
                                            type="button"
                                            className="btn primary sm"
                                            disabled={busyId === r.id}
                                            onClick={() => resolveQuick(r, "post")}
                                        >
                                            <Check size={14} />{" "}
                                            {busyId === r.id ? "Menyimpan…" : "Simpan 1-Klik"}
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        className="btn sm"
                                        disabled={busyId === r.id}
                                        onClick={() => onSelect(r)}
                                    >
                                        <Pencil size={13} /> Ubah / Tautkan…
                                    </button>
                                    <button
                                        type="button"
                                        className="btn sm"
                                        disabled={busyId === r.id}
                                        onClick={() => resolveQuick(r, "ignore")}
                                    >
                                        <X size={13} /> Abaikan
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            ) : (
                <p className="empty">Semua bukti sudah ditinjau. Tidak ada antrean tertunda.</p>
            )}
        </section>
    );
}
