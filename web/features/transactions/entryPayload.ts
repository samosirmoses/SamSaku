import { type Account, type Data, type Transaction, parseDigits } from "../../lib/domain";

export function shiftIsoDays(iso: string, deltaDays: number): string {
    const d = new Date(iso + "T12:00:00");
    d.setDate(d.getDate() + deltaDays);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function resolveEntryDefaults(
    data: Data,
    tx?: Transaction | null,
    initial?: { account_id?: string; to_account_id?: string }
): { defaultAccId: string; secondAccId: string } {
    const defaultAccId =
        tx?.account_id ||
        initial?.account_id ||
        (data.settings?.default_account_id && data.accounts.some(a => a.id === data.settings.default_account_id)
            ? data.settings.default_account_id
            : data.accounts[0]?.id || "");
    const secondAccId =
        tx?.to_account_id ||
        initial?.to_account_id ||
        data.accounts.find(a => a.id !== defaultAccId)?.id ||
        data.accounts[0]?.id ||
        "";
    return { defaultAccId, secondAccId };
}

export function computeAfterBalance(
    fromAcc: Account | undefined,
    kind: Transaction["kind"],
    numAmount: number,
    numFee: number
): number | null {
    if (!fromAcc || fromAcc.balance == null || numAmount <= 0) return null;
    if (kind === "income" || kind === "refund") return fromAcc.balance + numAmount;
    if (kind === "expense") return fromAcc.balance - numAmount;
    return fromAcc.balance - numAmount - numFee;
}

export type EntryPayloadInput = {
    isEdit: boolean;
    submitPath?: string;
    sourceRef: string;
    kind: Transaction["kind"];
    txDate: string;
    description: string;
    accountId: string;
    toAccountId: string;
    amount: string;
    fee: string;
    catId: string;
    split: boolean;
    splitAmount: string;
    splitCatId: string;
    originalId: string;
};

export function buildTransactionPayload(
    input: EntryPayloadInput
): { payload: Record<string, unknown>; numAmount: number } | { error: string; focusAmount?: boolean } {
    const numAmount = parseDigits(input.amount);
    if (!numAmount || numAmount <= 0) {
        return { error: "Masukkan nominal transaksi yang valid.", focusAmount: true };
    }

    let payload: Record<string, unknown> = {
        source_ref: input.submitPath || input.isEdit ? undefined : input.sourceRef,
        kind: input.kind,
        date: input.txDate,
        description: input.description.trim(),
        account_id: input.accountId,
        amount: numAmount,
        category_id: input.kind === "transfer" ? null : input.catId || null,
    };

    if (input.split && input.kind !== "transfer" && input.kind !== "refund") {
        const a = parseDigits(input.splitAmount);
        const b = input.splitCatId;
        if (!input.catId || !b || input.catId === b || a <= 0 || a >= numAmount) {
            return { error: "Pilih dua kategori berbeda dan nominal bagian pertama di antara nol dan total." };
        }
        payload = {
            ...payload,
            category_id: null,
            splits: [
                { category_id: input.catId, amount: a },
                { category_id: b, amount: numAmount - a },
            ],
        };
    }

    if (input.kind === "transfer") {
        payload.to_account_id = input.toAccountId;
        payload.fee = parseDigits(input.fee);
        if (payload.to_account_id === payload.account_id) {
            return { error: "Pilih dua dompet berbeda untuk transfer." };
        }
    }

    if (input.kind === "refund") {
        if (!input.originalId) {
            return { error: "Pilih transaksi pengeluaran asal untuk refund." };
        }
        payload.original_id = input.originalId;
    }

    return { payload, numAmount };
}
