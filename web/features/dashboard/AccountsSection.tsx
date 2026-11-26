"use client";
import { ArrowLeftRight, Coins, Landmark, ListFilter, Pencil, Plus, Smartphone, Wallet } from "lucide-react";
import { type Account, type Data, accountKindLabels, money } from "../../lib/domain";

export function AccountsSection({
    data,
    onOpen,
    onEdit,
    onTransfer,
    onFilterAccount,
    onAdd,
}: {
    data: Data;
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
                    <small className="muted">Total aset likuid: {money(totalBalance)}</small>
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
                        <button type="button" className="btn primary sm" onClick={onAdd} aria-label="Tambah dompet">
                            <Plus size={14} /> Dompet
                        </button>
                    )}
                    {!onAdd && <Wallet size={18} />}
                </div>
            </div>

            {data.accounts.length ? (
                <div className="wallet-cards-grid">
                    {data.accounts.map(a => {
                        const kindKey =
                            a.kind === "bank" || /bca|bank|mandiri|bri|bni|jago/i.test(a.name)
                                ? "bank"
                                : a.kind === "cash" || /tunai|cash/i.test(a.name)
                                  ? "cash"
                                  : "ewallet";
                        const Icon = kindKey === "bank" ? Landmark : kindKey === "cash" ? Coins : Smartphone;
                        const pct =
                            totalBalance > 0 && (a.balance || 0) > 0
                                ? Math.round((100 * (a.balance || 0)) / totalBalance)
                                : 0;
                        const isDefault = data.settings?.default_account_id === a.id;

                        return (
                            <div key={a.id} className={`wallet-visual-card ${kindKey}`}>
                                <div className="wvc-top">
                                    <div className="wvc-brand">
                                        <span className={`wvc-icon ${kindKey}`}>
                                            <Icon size={18} />
                                        </span>
                                        <div>
                                            <strong>{a.name}</strong>
                                            <small>
                                                {accountKindLabels[a.kind || kindKey] || "Dompet"}
                                                {isDefault ? " · Utama" : ""}
                                            </small>
                                        </div>
                                    </div>
                                    <span className="wvc-share">{pct}%</span>
                                </div>

                                <div className="wvc-balance">
                                    {a.balance == null ? "Saldo belum diatur" : money(a.balance)}
                                </div>

                                <div className="wvc-actions">
                                    {onFilterAccount && (
                                        <button
                                            type="button"
                                            className="wvc-action-btn"
                                            onClick={() => onFilterAccount(a.id)}
                                            title="Lihat mutasi dompet ini"
                                        >
                                            <ListFilter size={13} /> Mutasi
                                        </button>
                                    )}
                                    {onTransfer && data.accounts.length >= 2 && (
                                        <button
                                            type="button"
                                            className="wvc-action-btn"
                                            onClick={() => onTransfer(a.id)}
                                            title="Transfer dari dompet ini"
                                        >
                                            <ArrowLeftRight size={13} /> Transfer
                                        </button>
                                    )}
                                    {onEdit && (
                                        <button
                                            type="button"
                                            className="wvc-action-btn"
                                            onClick={() => onEdit(a)}
                                            title="Ubah atau hapus dompet"
                                        >
                                            <Pencil size={13} /> Edit
                                        </button>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            ) : onAdd || onOpen ? (
                <button onClick={onAdd || onOpen} className="text-btn">
                    + Tambah dompet pertama
                </button>
            ) : (
                <p className="empty">Belum ada dompet.</p>
            )}
        </section>
    );
}
