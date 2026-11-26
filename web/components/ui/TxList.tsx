"use client";
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight } from "lucide-react";
import { type Account, type Transaction, kindLabels, money, shortDate } from "../../lib/domain";

export function TxList({
    rows,
    accounts,
    open,
    showDate = true,
}: {
    rows: Transaction[];
    accounts: Account[];
    open: (t: Transaction) => void;
    showDate?: boolean;
}) {
    if (!rows.length) return <p className="empty">Belum ada transaksi untuk pilihan ini.</p>;
    return (
        <div className="tx-list">
            {rows.map(t => {
                const isTransfer = t.kind === "transfer";
                const positive = t.kind === "income" || t.kind === "refund";
                const Icon = isTransfer ? ArrowLeftRight : positive ? ArrowDownLeft : ArrowUpRight;
                const toneClass = isTransfer ? "transfer" : positive ? "positive" : "negative";
                const amountClass = isTransfer ? "transfer-amt" : positive ? "income" : "expense-amt";
                const fromName = t.account_name || accounts.find(a => a.id === t.account_id)?.name || "Dompet";
                const toName =
                    t.to_account_name ||
                    (t.to_account_id ? accounts.find(a => a.id === t.to_account_id)?.name : null);
                const walletLabel = isTransfer && toName ? `${fromName} → ${toName}` : fromName;
                const nonFeeSplits = (t.splits || []).filter(s => s.role !== "fee");
                const isSplit = nonFeeSplits.length > 1;
                const metaParts = [walletLabel];
                if (!isTransfer && !isSplit && t.category_name) metaParts.push(t.category_name);
                if (isTransfer && t.fee) metaParts.push(`Biaya ${money(t.fee)}`);
                if (showDate) metaParts.push(shortDate(t.date));

                return (
                    <button key={t.id} className="tx" onClick={() => open(t)}>
                        <span className={"tx-icon " + toneClass}>
                            <Icon size={18} />
                        </span>
                        <span className="tx-main">
                            <strong>{t.description || t.category_name || kindLabels[t.kind]}</strong>
                            <small>{metaParts.join(" · ")}</small>
                            {isSplit && (
                                <span className="tx-split-badges">
                                    {nonFeeSplits.map((s, idx) => (
                                        <span key={idx} className="tx-split-pill">
                                            {s.category_name || "Kategori"}: {money(Math.abs(s.amount))}
                                        </span>
                                    ))}
                                </span>
                            )}
                        </span>
                        <span className="tx-right">
                            <strong className={"amount " + amountClass}>
                                {positive ? "+" : isTransfer ? "⇄ " : "−"}
                                {money(t.amount)}
                            </strong>
                            <small className={"tx-kind-pill " + toneClass}>
                                {isSplit ? `Split (${nonFeeSplits.length})` : kindLabels[t.kind]}
                            </small>
                        </span>
                    </button>
                );
            })}
        </div>
    );
}
