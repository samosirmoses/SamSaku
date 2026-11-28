"use client";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { request } from "../../lib/api";
import {
    type Account,
    type Category,
    type Transaction,
    inferCategoryClient,
    kindLabels,
    matchCategoryClient,
    money,
    today,
} from "../../lib/domain";

export type ScanResult = {
    kind?: Transaction["kind"];
    merchant?: string;
    transaction_type?: string | null;
    amount?: number | null;
    fee?: number;
    amount_options?: number[];
    date?: string | null;
    category_id?: string | null;
    category_name?: string | null;
    account_id?: string | null;
    account_name?: string | null;
    to_account_id?: string | null;
    to_account_name?: string | null;
    account_guessed?: boolean;
};

export function useReceiptAutoFill({
    accounts,
    categories,
    transactions,
    accountId,
    toAccountId,
    onDetectedKind,
    onAmount,
    onDate,
    onDescription,
    onAccountId,
    onToAccountId,
    onFee,
    onSplitOff,
    onCategorySuggested,
    onError,
}: {
    accounts: Account[];
    categories: Category[];
    transactions: Transaction[];
    accountId: string;
    toAccountId: string;
    onDetectedKind: (kind: Transaction["kind"]) => void;
    onAmount: (val: string) => void;
    onDate: (val: string) => void;
    onDescription: (val: string) => void;
    onAccountId: (id: string) => void;
    onToAccountId: (id: string) => void;
    onFee: (val: string) => void;
    onSplitOff: () => void;
    onCategorySuggested: (id: string) => void;
    onError: (msg: string) => void;
}) {
    const [scanning, setScanning] = useState(false);
    const [scanInfo, setScanInfo] = useState("");
    const [receiptPreviewUrl, setReceiptPreviewUrl] = useState("");
    const [amountOptions, setAmountOptions] = useState<number[]>([]);
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        return () => {
            if (receiptPreviewUrl) URL.revokeObjectURL(receiptPreviewUrl);
        };
    }, [receiptPreviewUrl]);

    async function handleReceiptFile(e: ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (!file) return;
        if (receiptPreviewUrl) URL.revokeObjectURL(receiptPreviewUrl);
        setReceiptPreviewUrl(URL.createObjectURL(file));
        setScanning(true);
        onError("");
        setScanInfo("");
        setAmountOptions([]);
        try {
            const form = new FormData();
            form.append("file", file);
            const res = (await request("/receipts/scan", { method: "POST", body: form })) as ScanResult;
            const detectedKind: Transaction["kind"] =
                res.kind === "transfer" || res.kind === "income" || res.kind === "expense" ? res.kind : "expense";
            onDetectedKind(detectedKind);
            if (res.amount) onAmount(String(res.amount));
            if (res.amount_options && res.amount_options.length > 1) setAmountOptions(res.amount_options);
            if (res.date) onDate(res.date);
            if (res.merchant) onDescription(res.merchant);
            if (res.account_id && accounts.some(a => a.id === res.account_id)) {
                onAccountId(res.account_id);
            }
            if (detectedKind === "transfer") {
                onSplitOff();
                onCategorySuggested("");
                onFee(String(res.fee || 0));
                if (res.to_account_id && accounts.some(a => a.id === res.to_account_id)) {
                    onToAccountId(res.to_account_id);
                }
                const fromLabel =
                    res.account_name || accounts.find(a => a.id === (res.account_id || accountId))?.name || "Dompet asal";
                const toLabel =
                    res.to_account_name ||
                    accounts.find(a => a.id === (res.to_account_id || toAccountId))?.name ||
                    "Dompet tujuan";
                const feeNote = res.fee ? ` · Admin ${money(res.fee)}` : "";
                const guessNote = res.account_guessed ? " (dompet perkiraan)" : "";
                setScanInfo(
                    `Terdeteksi: Transfer · ${fromLabel} → ${toLabel}${feeNote}${guessNote} · ${res.date || today()}`
                );
            } else {
                onFee("0");
                const autoCat =
                    res.category_id ||
                    (detectedKind === "expense"
                        ? inferCategoryClient(res.merchant || file.name, categories, transactions)
                        : matchCategoryClient(res.merchant || file.name, categories, transactions, "income"));
                if (autoCat) onCategorySuggested(autoCat);
                const catLabel = res.category_name || categories.find(c => c.id === autoCat)?.name || "Otomatis";
                const typeTag = res.transaction_type ? ` (${res.transaction_type})` : "";
                const guessNote = res.account_guessed ? " · Dompet perkiraan" : "";
                setScanInfo(
                    `Terdeteksi: ${kindLabels[detectedKind]}${typeTag} · ${catLabel}${guessNote} · ${res.date || today()}`
                );
            }
        } catch (scanErr) {
            const cleanName = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
            const numMatch = cleanName.match(/(\d{2,9})/);
            onDetectedKind("expense");
            if (cleanName) onDescription(cleanName);
            if (numMatch) onAmount(numMatch[1]);
            const autoCat = matchCategoryClient(cleanName, categories, transactions, "expense");
            if (autoCat) onCategorySuggested(autoCat);
            setScanInfo("Silakan periksa nominal & kategori sebelum menyimpan.");
            onError(scanErr instanceof Error ? scanErr.message : "");
        } finally {
            setScanning(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    }

    function resetScan() {
        setScanInfo("");
        setAmountOptions([]);
    }

    return {
        scanning,
        scanInfo,
        receiptPreviewUrl,
        amountOptions,
        fileInputRef,
        handleReceiptFile,
        resetScan,
    };
}
