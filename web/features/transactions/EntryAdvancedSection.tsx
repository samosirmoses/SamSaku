"use client";
import { ChevronDown, ChevronUp, RotateCcw, SlidersHorizontal } from "lucide-react";
import { Field } from "../../components/ui";
import { type Category, formatDots } from "../../lib/domain";

export function EntryAdvancedSection({
    showAdvanced,
    onToggleAdvanced,
    split,
    onSplitChange,
    splitAmount,
    onSplitAmountChange,
    splitCatId,
    onSplitCatIdChange,
    catId,
    cats,
    canRefund,
    onSwitchToRefund,
}: {
    showAdvanced: boolean;
    onToggleAdvanced: () => void;
    split: boolean;
    onSplitChange: (next: boolean) => void;
    splitAmount: string;
    onSplitAmountChange: (val: string) => void;
    splitCatId: string;
    onSplitCatIdChange: (id: string) => void;
    catId: string;
    cats: Category[];
    canRefund: boolean;
    onSwitchToRefund: () => void;
}) {
    return (
        <div className="advanced-toggle-box">
            <button type="button" className="advanced-toggle-btn" onClick={onToggleAdvanced}>
                <SlidersHorizontal size={13} />
                <span>Opsi lanjutan (Split kategori{canRefund ? " / Refund" : ""})</span>
                {showAdvanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>

            {showAdvanced && (
                <div className="advanced-panel">
                    <label className="check">
                        <input type="checkbox" checked={split} onChange={e => onSplitChange(e.target.checked)} />
                        Bagi nominal ke dua kategori berbeda
                    </label>
                    {split && (
                        <div className="form-pair">
                            <Field label="Nominal kategori pertama (Rp)">
                                <input
                                    type="text"
                                    inputMode="numeric"
                                    name="split_amount"
                                    value={formatDots(splitAmount)}
                                    onChange={e => onSplitAmountChange(e.target.value.replace(/\D/g, ""))}
                                    required
                                />
                            </Field>
                            <Field label="Kategori kedua (sisa nominal)">
                                <select
                                    name="split_cat"
                                    value={splitCatId}
                                    onChange={e => onSplitCatIdChange(e.target.value)}
                                    required
                                >
                                    <option value="">Pilih kategori</option>
                                    {cats
                                        .filter(c => c.id !== catId)
                                        .map(c => (
                                            <option key={c.id} value={c.id}>
                                                {c.name}
                                            </option>
                                        ))}
                                </select>
                            </Field>
                        </div>
                    )}

                    {canRefund && (
                        <button
                            type="button"
                            className="btn sm"
                            style={{ justifySelf: "start" }}
                            onClick={onSwitchToRefund}
                        >
                            <RotateCcw size={13} /> Ubah ke pencatatan Refund pengeluaran
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}
