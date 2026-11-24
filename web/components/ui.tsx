"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { X, AlertCircle, ArrowDownLeft, ArrowUpRight, ArrowLeftRight, UtensilsCrossed, ShoppingBag, CarFront, ReceiptText, CircleDollarSign, Wallet } from "lucide-react";
import { type Transaction, type Account, money, shortDate, kindLabels } from "../lib/domain";
export function Modal({ title, children, onClose, wide = false }: {
    title: string;
    children: ReactNode;
    onClose: () => void;
    wide?: boolean;
}) {
    const ref = useRef<HTMLDialogElement>(null);
    const closeRef = useRef(onClose);
    closeRef.current = onClose;
    useEffect(() => { const d = ref.current; const origin = document.activeElement as HTMLElement | null; d?.showModal(); const old = document.body.style.overflow; document.body.style.overflow = "hidden"; return () => { document.body.style.overflow = old; d?.close(); origin?.focus(); }; }, []);
    return <dialog className={wide ? "dialog wide-dialog" : "dialog"} ref={ref} aria-labelledby="dialog-title" onCancel={e => { e.preventDefault(); closeRef.current?.(); }} onClick={e => { if (e.target === e.currentTarget) {
        const r = e.currentTarget.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
            onClose();
    } }}>
      <div className="dialog-header">
        <h2 id="dialog-title">
          {title}
        </h2>
        <button className="icon-btn" aria-label="Tutup" onClick={onClose}>
          <X size={20}/>
        </button>
      </div>
      <div className="dialog-body">
        {children}
      </div>
    </dialog>;
}
export function ErrorNote({ message }: {
    message: string;
}) { return message ? <p className="error-note" role="alert">
      <AlertCircle size={17}/>
      <span>
        {message}
      </span>
    </p> : null; }
export function Field({ label, children }: {
    label: string;
    children: ReactNode;
}) { return <label className="field">
      <span>
        {label}
      </span>
      {children}
    </label>; }
export function CatIcon({ name, size = 17 }: {
    name: string;
    size?: number;
}) { const Icon = /makan|kopi|minum|resto/i.test(name) ? UtensilsCrossed : /belanja/i.test(name) ? ShoppingBag : /transport/i.test(name) ? CarFront : /tagih/i.test(name) ? ReceiptText : /gaji|income/i.test(name) ? CircleDollarSign : Wallet; return <Icon size={size} strokeWidth={1.7}/>; }
export function TxList({ rows, accounts, open }: {
    rows: Transaction[];
    accounts: Account[];
    open: (t: Transaction) => void;
}) {
    if (!rows.length)
        return <p className="empty">Belum ada transaksi untuk pilihan ini.</p>;
    return <div className="tx-list">
      {rows.map(t => { const positive = t.kind === "income" || t.kind === "refund", Icon = t.kind === "transfer" ? ArrowLeftRight : positive ? ArrowDownLeft : ArrowUpRight; return <button key={t.id} className="tx" onClick={() => open(t)}>
        <span className={"tx-icon " + (positive ? "positive" : "")}>
          <Icon size={19}/>
        </span>
        <span className="tx-main">
          <strong>
            {t.description || t.category_name || kindLabels[t.kind]}
          </strong>
          <small>{t.account_name || accounts.find(a => a.id === t.account_id)?.name || "Dompet"} · {shortDate(t.date)}</small>
        </span>
        <strong className={"amount " + (positive ? "income" : "")}>
          {positive ? "+" : t.kind === "transfer" ? "" : "−"}
          {money(t.amount)}
        </strong>
      </button>; })}
    </div>;
}
