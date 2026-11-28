"use client";
import type { RefObject } from "react";
import { type Transaction, formatDots, kindLabels, money } from "../../lib/domain";

export function EntryAmountBox({
    kind,
    amount,
    numAmount,
    amountOptions,
    amountInputRef,
    onAmountChange,
}: {
    kind: Transaction["kind"];
    amount: string;
    numAmount: number;
    amountOptions: number[];
    amountInputRef: RefObject<HTMLInputElement | null>;
    onAmountChange: (val: string) => void;
}) {
    return (
        <div className={`amount-hero-box ${kind}`}>
            <div className="amount-hero-top">
                <span className="amount-hero-label">Nominal {kindLabels[kind]}</span>
                {numAmount > 0 && (
                    <button
                        type="button"
                        className="amount-clear-btn"
                        onClick={() => {
                            onAmountChange("");
                            amountInputRef.current?.focus();
                        }}
                    >
                        Hapus
                    </button>
                )}
            </div>
            <div className="amount-hero-input-row">
                <span className="currency-prefix">
                    {kind === "income" || kind === "refund" ? "+Rp" : kind === "transfer" ? "⇄ Rp" : "−Rp"}
                </span>
                <input
                    ref={amountInputRef}
                    type="text"
                    inputMode="numeric"
                    aria-label="Nominal (Rp)"
                    value={formatDots(amount)}
                    onChange={e => onAmountChange(e.target.value.replace(/\D/g, ""))}
                    placeholder="0"
                    required
                />
            </div>
            <div className="quick-nominal-row">
                {numAmount > 0 && numAmount < 100_000 && (
                    <button
                        type="button"
                        className="nominal-chip accent"
                        title="Kalikan 1.000"
                        onClick={() => onAmountChange(String(numAmount * 1000))}
                    >
                        .000
                    </button>
                )}
                {[15000, 25000, 50000, 100000, 250000].map(preset => (
                    <button
                        key={preset}
                        type="button"
                        className={"nominal-chip " + (numAmount === preset ? "active" : "")}
                        onClick={() => onAmountChange(String(preset))}
                    >
                        {preset / 1000}rb
                    </button>
                ))}
            </div>
            {amountOptions.length > 1 && (
                <div className="amount-chips" style={{ marginTop: 6 }}>
                    <small>Kandidat total dari struk:</small>
                    <div className="btns">
                        {amountOptions.map(val => (
                            <button
                                key={val}
                                type="button"
                                className={"chip " + (numAmount === val ? "active" : "")}
                                onClick={() => onAmountChange(String(val))}
                            >
                                {money(val)}
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
