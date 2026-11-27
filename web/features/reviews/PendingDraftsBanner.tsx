"use client";
import { useState } from "react";
import { Check, ChevronRight, Inbox, Pencil, X } from "lucide-react";
import { post } from "../../lib/api";
import { type Data, type Review, kindLabels, money, shortDate, today } from "../../lib/domain";

export function sourceLabel(src: string): string {
    const s = (src || "").toLowerCase();
    if (s === "bca") return "myBCA";
    if (s === "gopay") return "GoPay";
    if (s === "telegram") return "Telegram";
    if (s === "receipt") return "Foto Struk";
    return src.toUpperCase();
}

export function buildQuickReviewPayload(r: Review, data: Data): Record<string, unknown> | null {
    const p = r.parsed;
    if (!p || !p.amount || p.amount <= 0) return null;
    if (Array.isArray((p as Record<string, unknown>).candidates) && ((p as Record<string, unknown>).candidates as unknown[]).length > 0) {
        return null;
    }
    const kind = p.kind || "expense";
    const accountId =
        (p.account_id && data.accounts.some(a => a.id === p.account_id) ? p.account_id : "") ||
        (kind !== "transfer" &&
        data.settings?.default_account_id &&
        data.accounts.some(a => a.id === data.settings.default_account_id)
            ? data.settings.default_account_id
            : "");
    if (!accountId) return null;

    if (kind === "transfer") {
        if (!p.to_account_id || p.to_account_id === accountId || !data.accounts.some(a => a.id === p.to_account_id)) {
            return null;
        }
        return {
            date: p.date || today(),
            kind: "transfer",
            account_id: accountId,
            to_account_id: p.to_account_id,
            amount: p.amount,
            fee: Number(p.fee || 0),
            description: (p.description || p.merchant || r.text || "").slice(0, 500),
            category_id: null,
        };
    }

    const validCatId =
        p.category_id && data.categories.some(c => c.id === p.category_id && !c.archived) ? p.category_id : null;

    return {
        date: p.date || today(),
        kind: kind === "income" ? "income" : "expense",
        account_id: accountId,
        amount: p.amount,
        description: (p.description || p.merchant || r.text || "").slice(0, 500),
        category_id: validCatId,
    };
}

export function PendingDraftsBanner({
    data,
    highlightIds,
    onSelectReview,
    onOpenAllReviews,
    onResolved,
    onError,
}: {
    data: Data;
    highlightIds?: Set<string>;
    onSelectReview: (r: Review) => void;
    onOpenAllReviews: () => void;
    onResolved: (msg: string) => void;
    onError?: (msg: string) => void;
}) {
    const [busyId, setBusyId] = useState<string | null>(null);
    const reviews = data.reviews || [];
    if (!reviews.length) return null;

    const latest = reviews[0];
    const quickPayload = buildQuickReviewPayload(latest, data);
    const accName =
        data.accounts.find(a => a.id === (quickPayload?.account_id || latest.parsed?.account_id))?.name || "";
    const toAccName =
        latest.parsed?.to_account_id
            ? data.accounts.find(a => a.id === latest.parsed?.to_account_id)?.name || ""
            : "";
    const isFresh = highlightIds?.has(latest.id);

    async function handleQuickAction(action: "post" | "ignore") {
        setBusyId(latest.id);
        try {
            if (action === "post" && quickPayload) {
                await post(`/reviews/${latest.id}/resolve`, { action: "post", transaction: quickPayload });
                onResolved("Draf berhasil disimpan ke Transaksi.");
            } else {
                await post(`/reviews/${latest.id}/resolve`, { action: "ignore" });
                onResolved("Draf bukti diabaikan.");
            }
        } catch (err) {
            onError?.(err instanceof Error ? err.message : "Gagal memproses draf.");
        } finally {
            setBusyId(null);
        }
    }

    const pKind = latest.parsed?.kind || "expense";
    const summaryParts: string[] = [sourceLabel(latest.source)];
    if (latest.parsed?.amount) {
        const prefix = pKind === "income" ? "+" : pKind === "transfer" ? "⇄ " : "−";
        summaryParts.push(`${prefix}${money(latest.parsed.amount)}`);
    }
    if (pKind === "transfer" && accName && toAccName) {
        summaryParts.push(`${accName} → ${toAccName}`);
    } else if (accName) {
        summaryParts.push(accName);
    }
    if (latest.parsed?.date) summaryParts.push(shortDate(latest.parsed.date));

    return (
        <div className={"draft-live-banner" + (isFresh ? " pulse-new" : "")}>
            <div className="draft-banner-left">
                <span className="draft-banner-icon">
                    <Inbox size={18} />
                </span>
                <div className="draft-banner-info">
                    <div className="draft-banner-title">
                        <strong>
                            {reviews.length === 1
                                ? "1 draf transaksi baru menunggu konfirmasi"
                                : `${reviews.length} draf transaksi menunggu konfirmasi`}
                        </strong>
                        <span className="draft-meta-pill">{summaryParts.join(" · ")}</span>
                    </div>
                    <small className="draft-banner-desc">
                        {latest.parsed?.description || latest.parsed?.merchant || latest.text}
                    </small>
                </div>
            </div>

            <div className="draft-banner-actions">
                {quickPayload && (
                    <button
                        type="button"
                        className="btn primary sm"
                        disabled={busyId === latest.id}
                        onClick={() => handleQuickAction("post")}
                    >
                        <Check size={14} /> {busyId === latest.id ? "Menyimpan…" : "Simpan 1-Klik"}
                    </button>
                )}
                <button
                    type="button"
                    className="btn sm"
                    disabled={busyId === latest.id}
                    onClick={() => onSelectReview(latest)}
                >
                    <Pencil size={13} /> {quickPayload ? "Ubah" : "Tinjau"}
                </button>
                <button
                    type="button"
                    className="icon-btn sm-icon"
                    title="Abaikan draf ini"
                    disabled={busyId === latest.id}
                    onClick={() => handleQuickAction("ignore")}
                >
                    <X size={15} />
                </button>
                {reviews.length > 1 && (
                    <button type="button" className="text-btn sm" onClick={onOpenAllReviews}>
                        Semua ({reviews.length}) <ChevronRight size={14} />
                    </button>
                )}
            </div>
        </div>
    );
}
