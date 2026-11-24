"use client";
import { useEffect, useRef, type ReactNode } from "react";
import {
    X,
    AlertCircle,
    ArrowDownLeft,
    ArrowUpRight,
    ArrowLeftRight,
    UtensilsCrossed,
    ShoppingBag,
    CarFront,
    ReceiptText,
    CircleDollarSign,
    Wallet,
} from "lucide-react";
import { type Transaction, type Account, money, shortDate, kindLabels } from "../lib/domain";

export function Modal({
    title,
    children,
    onClose,
    wide = false,
}: {
    title: string;
    children: ReactNode;
    onClose: () => void;
    wide?: boolean;
}) {
    const ref = useRef<HTMLDialogElement>(null);
    const closeRef = useRef(onClose);
    closeRef.current = onClose;
    useEffect(() => {
        const d = ref.current;
        const origin = document.activeElement as HTMLElement | null;
        d?.showModal();
        const old = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        return () => {
            document.body.style.overflow = old;
            d?.close();
            origin?.focus();
        };
    }, []);
    return (
        <dialog
            className={wide ? "dialog wide-dialog" : "dialog"}
            ref={ref}
            aria-labelledby="dialog-title"
            onCancel={e => {
                e.preventDefault();
                closeRef.current?.();
            }}
            onClick={e => {
                if (e.target === e.currentTarget) {
                    const r = e.currentTarget.getBoundingClientRect();
                    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose();
                }
            }}
        >
            <div className="dialog-header">
                <h2 id="dialog-title">{title}</h2>
                <button className="icon-btn" aria-label="Tutup" onClick={onClose}>
                    <X size={20} />
                </button>
            </div>
            <div className="dialog-body">{children}</div>
        </dialog>
    );
}

export function ErrorNote({ message }: { message: string }) {
    return message ? (
        <p className="error-note" role="alert">
            <AlertCircle size={17} />
            <span>{message}</span>
        </p>
    ) : null;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
    return (
        <label className="field">
            <span>{label}</span>
            {children}
        </label>
    );
}

export function CatIcon({ name, size = 17 }: { name: string; size?: number }) {
    const Icon = /makan|kopi|minum|resto|kuliner/i.test(name)
        ? UtensilsCrossed
        : /belanja|shop|mart/i.test(name)
          ? ShoppingBag
          : /transport|jalan|bensin/i.test(name)
            ? CarFront
            : /tagih|listrik|air|pulsa/i.test(name)
              ? ReceiptText
              : /gaji|income|bonus/i.test(name)
                ? CircleDollarSign
                : Wallet;
    return <Icon size={size} strokeWidth={1.7} />;
}

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
                const splitSummary = isSplit
                    ? nonFeeSplits
                          .map(s => `${s.category_name || "Kategori"} (${money(Math.abs(s.amount))})`)
                          .join(" + ")
                    : null;
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
