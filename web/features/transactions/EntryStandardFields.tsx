"use client";
import { Field, WalletIcon } from "../../components/ui";
import { type Account, type Category, type Transaction, money } from "../../lib/domain";
import { CategoryPicker } from "./CategoryPicker";

export function EntryStandardFields({
    kind,
    accounts,
    categories,
    transactions,
    expenses,
    accountId,
    catId,
    originalId,
    autoSuggestedCat,
    userPickedCat,
    busy,
    activeAccountAfterBalance,
    onOriginalIdChange,
    onAccountIdChange,
    onCategoryChange,
    onCategoryCreated,
    onError,
}: {
    kind: Exclude<Transaction["kind"], "transfer">;
    accounts: Account[];
    categories: Category[];
    transactions: Transaction[];
    expenses: Transaction[];
    accountId: string;
    catId: string;
    originalId: string;
    autoSuggestedCat: boolean;
    userPickedCat: boolean;
    busy: boolean;
    activeAccountAfterBalance: number | null;
    onOriginalIdChange: (id: string) => void;
    onAccountIdChange: (id: string) => void;
    onCategoryChange: (id: string, manual: boolean) => void;
    onCategoryCreated: (cat: Category) => void;
    onError: (msg: string) => void;
}) {
    const fromAcc = accounts.find(a => a.id === accountId);

    return (
        <>
            {kind === "refund" ? (
                <Field label="Transaksi pengeluaran asal yang di-refund">
                    <select
                        name="original_id"
                        required
                        value={originalId}
                        onChange={e => onOriginalIdChange(e.target.value)}
                    >
                        <option value="">Pilih pengeluaran asal…</option>
                        {expenses.map(t => (
                            <option key={t.id} value={t.id}>
                                {t.date} · {t.description || "Pengeluaran"} · {money(t.amount)}
                            </option>
                        ))}
                    </select>
                </Field>
            ) : (
                <CategoryPicker
                    categories={categories}
                    transactions={transactions}
                    kind={kind === "income" ? "income" : "expense"}
                    value={catId}
                    autoSuggested={autoSuggestedCat && !userPickedCat}
                    disabled={busy}
                    onChange={onCategoryChange}
                    onCategoryCreated={onCategoryCreated}
                    onError={onError}
                />
            )}

            <div className="field">
                <div className="cat-picker-header">
                    <span>Dompet</span>
                    {fromAcc && activeAccountAfterBalance !== null && (
                        <small className="wallet-after-hint">
                            Sisa {fromAcc.name}: <b>{money(activeAccountAfterBalance)}</b>
                        </small>
                    )}
                </div>
                <div className="wallet-chip-row">
                    {accounts.map(a => (
                        <button
                            type="button"
                            key={a.id}
                            className={"wallet-pick-card " + (accountId === a.id ? "active" : "")}
                            onClick={() => onAccountIdChange(a.id)}
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
        </>
    );
}
