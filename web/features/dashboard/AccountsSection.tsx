"use client";
import { ArrowLeftRight, Coins, Landmark, ListFilter, Pencil, Plus, Smartphone, Wallet } from "lucide-react";
import { type Account, type Data, accountKindLabels, maskAccountNumber, money } from "../../lib/domain";

export function AccountsSection({
    data,
    horizontal = false,
    onOpen,
    onEdit,
    onTransfer,
    onFilterAccount,
    onAdd,
}: {
    data: Data;
    horizontal?: boolean;
    onOpen?: () => void;
    onEdit?: (a: Account) => void;
    onTransfer?: (fromAccountId?: string) => void;
    onFilterAccount?: (accountId: string) => void;
    onAdd?: () => void;
}) {
    const totalBalance = data.accounts.reduce((acc, a) => acc + Math.max(0, a.balance || 0), 0);

    return (
        <section className="card">
            <div className="section-title">
                <div>
                    <h2>Dompet Saya</h2>
                    {!horizontal && <small className="muted">Total aset likuid: {money(totalBalance)}</small>}
                </div>
                <div className="btns">
                    {onTransfer && data.accounts.length >= 2 && (
                        <button
                            type="button"
                            className="btn sm"
                            onClick={() => onTransfer()}
                            title="Transfer antar dompet"
                        >
                            <ArrowLeftRight size={14} /> Transfer
                        </button>
                    )}
                    {onAdd && (
                        <button type="button" className="btn sm" onClick={onAdd} aria-label="Tambah dompet">
                            <Plus size={14} /> Dompet
                        </button>
                    )}
                    {!onAdd && <Wallet size={18} />}
                </div>
            </div>

            {data.accounts.length ? (
                <div className={"wallet-cards-grid" + (horizontal ? " horizontal" : "")}>
                    {data.accounts.map(a => {
                        const kindKey =
                            a.kind === "bank" || /bca|bank|mandiri|bri|bni|jago/i.test(a.name)
                                ? "bank"
                                : a.kind === "cash" || /tunai|cash/i.test(a.name)
                                  ? "cash"
                                  : "ewallet";
                        const Icon = kindKey === "bank" ? Landmark : kindKey === "cash" ? Coins : Smartphone;
                        const isDefault = data.settings?.default_account_id === a.id;

                        return (
                            <div
                                key={a.id}
                                className={`wallet-visual-card ${kindKey}` + (horizontal ? " compact-wvc" : "")}
                            >
                                <div className="wvc-top">
                                    <div className="wvc-brand">
                                        <span className={`wvc-icon ${kindKey}`}>
                                            <Icon size={17} />
                                        </span>
                                        <div className="wvc-title-wrap">
                                            <strong>
                                                {a.name}
                                                {isDefault && <em className="wvc-default-tag">Utama</em>}
                                            </strong>
                                            <small>
                                                {accountKindLabels[a.kind || kindKey] || "Dompet"}
                                                {a.account_number ? ` · ${maskAccountNumber(a.account_number)}` : ""}
                                            </small>
                                        </div>
                                    </div>

                                    <div className="wvc-quick-icons">
                                        {onFilterAccount && (
                                            <button
                                                type="button"
                                                className="icon-btn sm-icon"
                                                onClick={() => onFilterAccount(a.id)}
                                                title={`Lihat mutasi ${a.name}`}
                                                aria-label={`Lihat mutasi ${a.name}`}
                                            >
                                                <ListFilter size={14} />
                                            </button>
                                        )}
                                        {onTransfer && data.accounts.length >= 2 && (
                                            <button
                                                type="button"
                                                className="icon-btn sm-icon"
                                                onClick={() => onTransfer(a.id)}
                                                title={`Transfer dari ${a.name}`}
                                                aria-label={`Transfer dari ${a.name}`}
                                            >
                                                <ArrowLeftRight size={14} />
                                            </button>
                                        )}
                                        {onEdit && (
                                            <button
                                                type="button"
                                                className="icon-btn sm-icon"
                                                onClick={() => onEdit(a)}
                                                title={`Edit ${a.name}`}
                                                aria-label={`Edit ${a.name}`}
                                            >
                                                <Pencil size={14} />
                                            </button>
                                        )}
                                    </div>
                                </div>

                                <button
                                    type="button"
                                    className="wvc-balance-btn"
                                    onClick={() => onFilterAccount?.(a.id)}
                                    title={onFilterAccount ? `Klik untuk filter transaksi ${a.name}` : undefined}
                                >
                                    <span className="wvc-balance">
                                        {a.balance == null ? "Saldo belum diatur" : money(a.balance)}
                                    </span>
                                </button>
                            </div>
                        );
                    })}
                </div>
            ) : onAdd || onOpen ? (
                <button onClick={onAdd || onOpen} className="btn primary sm">
                    <Plus size={14} /> Tambah dompet pertama
                </button>
            ) : (
                <p className="empty">Belum ada dompet.</p>
            )}
        </section>
    );
}
