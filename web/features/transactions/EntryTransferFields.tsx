"use client";
import { ArrowLeftRight, ArrowRight } from "lucide-react";
import { Field, WalletIcon } from "../../components/ui";
import { type Account, formatDots, money } from "../../lib/domain";

export function EntryTransferFields({
    accounts,
    accountId,
    toAccountId,
    fee,
    numAmount,
    numFee,
    onAccountId,
    onToAccountId,
    onFee,
}: {
    accounts: Account[];
    accountId: string;
    toAccountId: string;
    fee: string;
    numAmount: number;
    numFee: number;
    onAccountId: (id: string) => void;
    onToAccountId: (id: string) => void;
    onFee: (val: string) => void;
}) {
    const fromAcc = accounts.find(a => a.id === accountId);
    const toAcc = accounts.find(a => a.id === toAccountId);

    return (
        <div className="transfer-box">
            <div className="transfer-wallets-grid">
                <div className="field">
                    <span>Dari Dompet Asal</span>
                    <div className="wallet-chip-grid">
                        {accounts.map(a => (
                            <button
                                type="button"
                                key={a.id}
                                className={"wallet-pick-card " + (accountId === a.id ? "active" : "")}
                                onClick={() => {
                                    onAccountId(a.id);
                                    if (a.id === toAccountId) {
                                        const alt = accounts.find(x => x.id !== a.id);
                                        if (alt) onToAccountId(alt.id);
                                    }
                                }}
                            >
                                <WalletIcon kind={a.kind} name={a.name} size={16} />
                                <div>
                                    <strong>{a.name}</strong>
                                    <small>{a.balance != null ? money(a.balance) : "—"}</small>
                                </div>
                            </button>
                        ))}
                    </div>
                </div>

                <button
                    type="button"
                    className="swap-wallets-btn"
                    title="Tukar dompet asal dan tujuan"
                    onClick={() => {
                        const prevFrom = accountId;
                        onAccountId(toAccountId);
                        onToAccountId(prevFrom);
                    }}
                >
                    <ArrowLeftRight size={18} />
                </button>

                <div className="field">
                    <span>Ke Dompet Tujuan</span>
                    <div className="wallet-chip-grid">
                        {accounts.map(a => (
                            <button
                                type="button"
                                key={a.id}
                                className={"wallet-pick-card to " + (toAccountId === a.id ? "active" : "")}
                                onClick={() => {
                                    onToAccountId(a.id);
                                    if (a.id === accountId) {
                                        const alt = accounts.find(x => x.id !== a.id);
                                        if (alt) onAccountId(alt.id);
                                    }
                                }}
                            >
                                <WalletIcon kind={a.kind} name={a.name} size={16} />
                                <div>
                                    <strong>{a.name}</strong>
                                    <small>{a.balance != null ? money(a.balance) : "—"}</small>
                                </div>
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            <div className="fee-inline-row">
                <Field label="Biaya admin (opsional)">
                    <input
                        type="text"
                        inputMode="numeric"
                        name="fee"
                        value={formatDots(fee)}
                        onChange={e => onFee(e.target.value.replace(/\D/g, ""))}
                        placeholder="0"
                    />
                </Field>
                <div className="quick-nominal-row fee-presets">
                    {[0, 1000, 2500, 6500].map(f => (
                        <button
                            key={f}
                            type="button"
                            className={"nominal-chip " + (numFee === f ? "active" : "")}
                            onClick={() => onFee(String(f))}
                        >
                            {f === 0 ? "Gratis" : `Rp${formatDots(String(f))}`}
                        </button>
                    ))}
                </div>
            </div>

            {fromAcc && toAcc && numAmount > 0 && (
                <div className="transfer-sim-card">
                    <div className="transfer-sim-row">
                        <span>
                            <b>{fromAcc.name}</b>
                        </span>
                        <span>
                            {money(fromAcc.balance || 0)} <ArrowRight size={13} />{" "}
                            <b className="expense-amt">{money((fromAcc.balance || 0) - numAmount - numFee)}</b>
                        </span>
                    </div>
                    <div className="transfer-sim-row">
                        <span>
                            <b>{toAcc.name}</b>
                        </span>
                        <span>
                            {money(toAcc.balance || 0)} <ArrowRight size={13} />{" "}
                            <b className="income">{money((toAcc.balance || 0) + numAmount)}</b>
                        </span>
                    </div>
                </div>
            )}
        </div>
    );
}
