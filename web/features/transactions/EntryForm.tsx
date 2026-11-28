"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ErrorNote, Field } from "../../components/ui";
import { del, get, post, put } from "../../lib/api";
import {
    type Data,
    type Transaction,
    generateUUID,
    matchCategoryClient,
    money,
    parseDigits,
    today,
} from "../../lib/domain";
import { EntryAdvancedSection } from "./EntryAdvancedSection";
import { EntryAmountBox } from "./EntryAmountBox";
import { EntryFormFooter } from "./EntryFormFooter";
import { EntryHeaderControls } from "./EntryHeaderControls";
import { EntryStandardFields } from "./EntryStandardFields";
import { EntryTransferFields } from "./EntryTransferFields";
import {
    buildTransactionPayload,
    computeAfterBalance,
    resolveEntryDefaults,
    shiftIsoDays,
} from "./entryPayload";
import { useReceiptAutoFill } from "./useReceiptAutoFill";

const toErr = (e: unknown) => (e instanceof Error ? e.message : "Gagal menyimpan perubahan.");

export function EntryForm({
    data,
    onDone,
    onSavedKeepOpen,
    tx,
    autoScan = false,
    submitPath,
    wrap,
    initial = {},
}: {
    data: Data;
    onDone: () => void;
    onSavedKeepOpen?: () => void;
    tx?: Transaction | null;
    autoScan?: boolean;
    submitPath?: string;
    wrap?: (t: Record<string, unknown>) => unknown;
    initial?: {
        description?: string;
        amount?: number;
        date?: string;
        kind?: Transaction["kind"];
        account_id?: string;
        to_account_id?: string;
        category_id?: string;
        fee?: number;
    };
}) {
    const { defaultAccId, secondAccId } = resolveEntryDefaults(data, tx, initial);

    const [kind, setKind] = useState<Transaction["kind"]>(tx?.kind || initial.kind || "expense");
    const [amount, setAmount] = useState<string>(
        tx?.amount != null ? String(tx.amount) : initial.amount != null ? String(initial.amount) : ""
    );
    const [txDate, setTxDate] = useState<string>(tx?.date || initial.date || today());
    const [description, setDescription] = useState<string>(tx?.description || initial.description || "");
    const [accountId, setAccountId] = useState<string>(defaultAccId);
    const [toAccountId, setToAccountId] = useState<string>(secondAccId);
    const [fee, setFee] = useState<string>(
        tx?.fee != null ? String(tx.fee) : initial.fee != null ? String(initial.fee) : "0"
    );
    const [originalId, setOriginalId] = useState<string>(tx?.original_id || "");

    const hasExistingSplits = !!(tx?.splits && tx.splits.filter(s => s.role !== "fee").length > 1);
    const [split, setSplit] = useState(hasExistingSplits);
    const [catId, setCatId] = useState<string>(
        tx?.category_id || (hasExistingSplits ? tx?.splits?.[0]?.category_id || "" : "") || initial.category_id || ""
    );
    const [userPickedCat, setUserPickedCat] = useState<boolean>(!!(tx?.category_id || initial.category_id));
    const [autoSuggestedCat, setAutoSuggestedCat] = useState<boolean>(false);
    const [splitAmount, setSplitAmount] = useState<string>(
        hasExistingSplits && tx?.splits?.[0] ? String(Math.abs(tx.splits[0].amount)) : ""
    );
    const [splitCatId, setSplitCatId] = useState<string>(
        hasExistingSplits && tx?.splits?.[1] ? tx.splits[1].category_id || "" : ""
    );
    const [showAdvanced, setShowAdvanced] = useState<boolean>(
        hasExistingSplits || (tx?.kind || initial.kind) === "refund"
    );
    const [categories, setCategories] = useState(data.categories);
    const [expenses, setExpenses] = useState(data.transactions.filter(t => t.kind === "expense" && t.id !== tx?.id));
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [savedFlash, setSavedFlash] = useState<string>("");
    const [confirmDelete, setConfirmDelete] = useState(false);

    const amountInputRef = useRef<HTMLInputElement>(null);
    const sourceRef = useRef("");
    const keepOpenAfterSubmit = useRef(false);

    const { scanning, scanInfo, receiptPreviewUrl, amountOptions, fileInputRef, handleReceiptFile, resetScan } =
        useReceiptAutoFill({
            accounts: data.accounts,
            categories,
            transactions: data.transactions,
            accountId,
            toAccountId,
            onDetectedKind: setKind,
            onAmount: setAmount,
            onDate: setTxDate,
            onDescription: setDescription,
            onAccountId: setAccountId,
            onToAccountId: setToAccountId,
            onFee: setFee,
            onSplitOff: () => setSplit(false),
            onCategorySuggested: id => {
                setCatId(id);
                setAutoSuggestedCat(!!id);
            },
            onError: msg => {
                setError(msg);
                setSavedFlash("");
            },
        });

    useEffect(() => {
        setCategories(data.categories);
    }, [data.categories]);

    useEffect(() => {
        if (!tx && !autoScan && !submitPath) {
            const t = setTimeout(() => amountInputRef.current?.focus(), 40);
            return () => clearTimeout(t);
        }
    }, [tx, autoScan, submitPath]);

    useEffect(() => {
        let active = true;
        if (kind === "refund") {
            get<Transaction[]>("/transactions")
                .then(rows => {
                    if (active) setExpenses(rows.filter(t => t.kind === "expense" && t.id !== tx?.id));
                })
                .catch(() => {});
        }
        return () => {
            active = false;
        };
    }, [kind, tx?.id]);

    const cats = categories.filter(c => !c.archived && c.kind === (kind === "income" ? "income" : "expense"));

    async function submit(e: FormEvent<HTMLFormElement>) {
        e.preventDefault();
        const wantKeepOpen = keepOpenAfterSubmit.current;
        keepOpenAfterSubmit.current = false;
        if (!sourceRef.current) sourceRef.current = generateUUID();

        const built = buildTransactionPayload({
            isEdit: !!tx,
            submitPath,
            sourceRef: sourceRef.current,
            kind,
            txDate,
            description,
            accountId,
            toAccountId,
            amount,
            fee,
            catId,
            split,
            splitAmount,
            splitCatId,
            originalId,
        });
        if ("error" in built) {
            setError(built.error);
            if (built.focusAmount) amountInputRef.current?.focus();
            return;
        }
        setError("");
        setSavedFlash("");
        setBusy(true);
        try {
            if (tx) await put("/transactions/" + tx.id, built.payload);
            else await post(submitPath || "/transactions", wrap ? wrap(built.payload) : built.payload);

            if (wantKeepOpen && !tx && !submitPath) {
                sourceRef.current = generateUUID();
                setAmount("");
                setDescription("");
                setFee("0");
                setSplit(false);
                setSplitAmount("");
                setSplitCatId("");
                resetScan();
                setUserPickedCat(false);
                setAutoSuggestedCat(false);
                setSavedFlash(`Tersimpan (${money(built.numAmount)}). Lanjut catat transaksi berikutnya!`);
                onSavedKeepOpen?.();
                setTimeout(() => amountInputRef.current?.focus(), 30);
            } else {
                onDone();
            }
        } catch (err) {
            setError(toErr(err));
        } finally {
            setBusy(false);
        }
    }

    async function removeTx() {
        if (!tx) return;
        setBusy(true);
        setError("");
        try {
            await del("/transactions/" + tx.id);
            onDone();
        } catch (err) {
            setError(toErr(err));
        } finally {
            setBusy(false);
        }
    }

    if (!data.accounts.length) return <p className="empty">Buat dompet di Master data terlebih dahulu.</p>;

    const numAmount = parseDigits(amount);
    const numFee = parseDigits(fee);
    const todayIso = today();
    const yesterdayIso = shiftIsoDays(todayIso, -1);
    const activeAccountAfterBalance = computeAfterBalance(
        data.accounts.find(a => a.id === accountId),
        kind,
        numAmount,
        numFee
    );

    return (
        <form className="form quick-entry-form" onSubmit={submit}>
            <EntryHeaderControls
                isEdit={!!tx}
                autoScan={autoScan}
                kind={kind}
                txDate={txDate}
                todayIso={todayIso}
                yesterdayIso={yesterdayIso}
                busy={busy}
                scanning={scanning}
                scanInfo={scanInfo}
                savedFlash={savedFlash}
                receiptPreviewUrl={receiptPreviewUrl}
                fileInputRef={fileInputRef}
                categories={categories}
                catId={catId}
                onKindChange={next => {
                    setKind(next);
                    if (next === "transfer") setSplit(false);
                }}
                onClearOriginalId={() => setOriginalId("")}
                onResetCategoryIfInvalid={() => {
                    setCatId("");
                    setUserPickedCat(false);
                    setAutoSuggestedCat(false);
                }}
                onDateChange={setTxDate}
                onReceiptFile={handleReceiptFile}
            />

            <EntryAmountBox
                kind={kind}
                amount={amount}
                numAmount={numAmount}
                amountOptions={amountOptions}
                amountInputRef={amountInputRef}
                onAmountChange={setAmount}
            />

            {kind === "transfer" ? (
                <EntryTransferFields
                    accounts={data.accounts}
                    accountId={accountId}
                    toAccountId={toAccountId}
                    fee={fee}
                    numAmount={numAmount}
                    numFee={numFee}
                    onAccountId={setAccountId}
                    onToAccountId={setToAccountId}
                    onFee={setFee}
                />
            ) : (
                <EntryStandardFields
                    kind={kind}
                    accounts={data.accounts}
                    categories={categories}
                    transactions={data.transactions}
                    expenses={expenses}
                    accountId={accountId}
                    catId={catId}
                    originalId={originalId}
                    autoSuggestedCat={autoSuggestedCat}
                    userPickedCat={userPickedCat}
                    busy={busy}
                    activeAccountAfterBalance={activeAccountAfterBalance}
                    onOriginalIdChange={setOriginalId}
                    onAccountIdChange={setAccountId}
                    onCategoryChange={(nextId, manual) => {
                        setCatId(nextId);
                        if (manual) {
                            setUserPickedCat(!!nextId);
                            setAutoSuggestedCat(false);
                        }
                    }}
                    onCategoryCreated={created => {
                        setCategories(prev => [...prev, created]);
                        setUserPickedCat(true);
                        setAutoSuggestedCat(false);
                    }}
                    onError={setError}
                />
            )}

            <Field label="Catatan singkat / Merchant (opsional)">
                <input
                    name="description"
                    value={description}
                    onChange={e => {
                        const val = e.target.value;
                        setDescription(val);
                        if (!userPickedCat && (kind === "expense" || kind === "income") && val.trim().length >= 3) {
                            const guessed = matchCategoryClient(
                                val,
                                categories,
                                data.transactions,
                                kind === "income" ? "income" : "expense"
                            );
                            if (guessed) {
                                setCatId(guessed);
                                setAutoSuggestedCat(true);
                            }
                        }
                    }}
                    placeholder={
                        kind === "transfer"
                            ? "Contoh: Top up GoPay"
                            : kind === "income"
                              ? "Contoh: Gaji bulanan, Fee proyek"
                              : "Contoh: Kopi Tuku, Makan siang, Indomaret"
                    }
                />
            </Field>

            {kind !== "transfer" && kind !== "refund" && (
                <EntryAdvancedSection
                    showAdvanced={showAdvanced}
                    onToggleAdvanced={() => setShowAdvanced(v => !v)}
                    split={split}
                    onSplitChange={setSplit}
                    splitAmount={splitAmount}
                    onSplitAmountChange={setSplitAmount}
                    splitCatId={splitCatId}
                    onSplitCatIdChange={setSplitCatId}
                    catId={catId}
                    cats={cats}
                    canRefund={!tx && !submitPath}
                    onSwitchToRefund={() => {
                        setSplit(false);
                        setKind("refund");
                    }}
                />
            )}

            <ErrorNote message={error} />

            <EntryFormFooter
                isEdit={!!tx}
                kind={kind}
                numAmount={numAmount}
                txAmount={tx?.amount}
                busy={busy}
                scanning={scanning}
                canKeepOpen={!tx && !submitPath && !!onSavedKeepOpen}
                confirmDelete={confirmDelete}
                onKeepOpenClick={() => {
                    keepOpenAfterSubmit.current = true;
                }}
                onRequestDelete={() => setConfirmDelete(true)}
                onCancelDelete={() => setConfirmDelete(false)}
                onConfirmDelete={removeTx}
            />
        </form>
    );
}
