"use client";
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import {
    ArrowDownLeft,
    ArrowLeftRight,
    ArrowRight,
    ArrowUpRight,
    Camera,
    CheckCircle2,
    ChevronDown,
    ChevronUp,
    Plus,
    RotateCcw,
    SlidersHorizontal,
    Sparkles,
    Trash2,
    X,
} from "lucide-react";
import { ErrorNote, Field, WalletIcon } from "../../components/ui";
import { del, get, post, put, request } from "../../lib/api";
import {
    type Data,
    type Transaction,
    formatDots,
    inferCategoryClient,
    kindLabels,
    matchCategoryClient,
    money,
    parseDigits,
    shortDate,
    today,
} from "../../lib/domain";
import { CategoryPicker } from "./CategoryPicker";

const toErr = (e: unknown) => (e instanceof Error ? e.message : "Gagal menyimpan perubahan.");

function shiftIsoDays(iso: string, deltaDays: number): string {
    const d = new Date(iso + "T12:00:00");
    d.setDate(d.getDate() + deltaDays);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

type ScanResult = {
    kind?: Transaction["kind"];
    merchant?: string;
    merchant_name?: string;
    transaction_type?: string | null;
    note?: string | null;
    items?: string[];
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
    engine?: string;
};

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
    const defaultAccId =
        tx?.account_id ||
        initial.account_id ||
        (data.settings?.default_account_id && data.accounts.some(a => a.id === data.settings.default_account_id)
            ? data.settings.default_account_id
            : data.accounts[0]?.id || "");
    const secondAccId =
        tx?.to_account_id ||
        initial.to_account_id ||
        data.accounts.find(a => a.id !== defaultAccId)?.id ||
        data.accounts[0]?.id ||
        "";

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
        tx?.category_id ||
            (hasExistingSplits ? tx?.splits?.[0]?.category_id || "" : "") ||
            initial.category_id ||
            ""
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
    const [scanning, setScanning] = useState(false);
    const [scanInfo, setScanInfo] = useState<string>("");
    const [savedFlash, setSavedFlash] = useState<string>("");
    const [receiptPreviewUrl, setReceiptPreviewUrl] = useState<string>("");
    const [amountOptions, setAmountOptions] = useState<number[]>([]);
    const [confirmDelete, setConfirmDelete] = useState(false);

    const fileInputRef = useRef<HTMLInputElement>(null);
    const amountInputRef = useRef<HTMLInputElement>(null);
    const sourceRef = useRef("");
    const keepOpenAfterSubmit = useRef(false);

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
        return () => {
            if (receiptPreviewUrl) URL.revokeObjectURL(receiptPreviewUrl);
        };
    }, [receiptPreviewUrl]);

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

    async function handleReceiptFile(e: ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (!file) return;
        if (receiptPreviewUrl) URL.revokeObjectURL(receiptPreviewUrl);
        setReceiptPreviewUrl(URL.createObjectURL(file));
        setScanning(true);
        setError("");
        setScanInfo("");
        setSavedFlash("");
        setAmountOptions([]);
        try {
            const form = new FormData();
            form.append("file", file);
            const res = (await request("/receipts/scan", { method: "POST", body: form })) as ScanResult;
            const detectedKind: Transaction["kind"] =
                res.kind === "transfer" || res.kind === "income" || res.kind === "expense" ? res.kind : "expense";
            setKind(detectedKind);
            if (res.amount) setAmount(String(res.amount));
            if (res.amount_options && res.amount_options.length > 1) setAmountOptions(res.amount_options);
            if (res.date) setTxDate(res.date);
            if (res.merchant) setDescription(res.merchant);
            if (res.account_id && data.accounts.some(a => a.id === res.account_id)) {
                setAccountId(res.account_id);
            }
            if (detectedKind === "transfer") {
                setSplit(false);
                setCatId("");
                setFee(String(res.fee || 0));
                if (res.to_account_id && data.accounts.some(a => a.id === res.to_account_id)) {
                    setToAccountId(res.to_account_id);
                }
                const fromLabel =
                    res.account_name ||
                    data.accounts.find(a => a.id === (res.account_id || accountId))?.name ||
                    "Dompet asal";
                const toLabel =
                    res.to_account_name ||
                    data.accounts.find(a => a.id === (res.to_account_id || toAccountId))?.name ||
                    "Dompet tujuan";
                const feeNote = res.fee ? ` · Admin ${money(res.fee)}` : "";
                const guessNote = res.account_guessed ? " (dompet perkiraan)" : "";
                setScanInfo(
                    `Terdeteksi: Transfer · ${fromLabel} → ${toLabel}${feeNote}${guessNote} · ${res.date || today()}`
                );
            } else {
                setFee("0");
                const autoCat =
                    res.category_id ||
                    (detectedKind === "expense"
                        ? inferCategoryClient(res.merchant || file.name, categories, data.transactions)
                        : matchCategoryClient(res.merchant || file.name, categories, data.transactions, "income"));
                if (autoCat) {
                    setCatId(autoCat);
                    setAutoSuggestedCat(true);
                }
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
            setKind("expense");
            if (cleanName) setDescription(cleanName);
            if (numMatch) setAmount(numMatch[1]);
            const autoCat = matchCategoryClient(cleanName, categories, data.transactions, "expense");
            if (autoCat) {
                setCatId(autoCat);
                setAutoSuggestedCat(true);
            }
            setScanInfo("Silakan periksa nominal & kategori sebelum menyimpan.");
            setError(scanErr instanceof Error ? scanErr.message : "");
        } finally {
            setScanning(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    }

    async function submit(e: FormEvent<HTMLFormElement>) {
        e.preventDefault();
        const wantKeepOpen = keepOpenAfterSubmit.current;
        keepOpenAfterSubmit.current = false;

        const numAmount = parseDigits(amount);
        if (!numAmount || numAmount <= 0) {
            setError("Masukkan nominal transaksi yang valid.");
            amountInputRef.current?.focus();
            return;
        }
        if (!sourceRef.current) sourceRef.current = crypto.randomUUID();
        let payload: Record<string, unknown> = {
            source_ref: submitPath || tx ? undefined : sourceRef.current,
            kind,
            date: txDate,
            description: description.trim(),
            account_id: accountId,
            amount: numAmount,
            category_id: kind === "transfer" ? null : catId || null,
        };
        setError("");
        setSavedFlash("");
        if (split && kind !== "transfer" && kind !== "refund") {
            const a = parseDigits(splitAmount);
            const b = splitCatId;
            if (!catId || !b || catId === b || a <= 0 || a >= numAmount) {
                setError("Pilih dua kategori berbeda dan nominal bagian pertama di antara nol dan total.");
                return;
            }
            payload = {
                ...payload,
                category_id: null,
                splits: [
                    { category_id: catId, amount: a },
                    { category_id: b, amount: numAmount - a },
                ],
            };
        }
        if (kind === "transfer") {
            payload.to_account_id = toAccountId;
            payload.fee = parseDigits(fee);
            if (payload.to_account_id === payload.account_id) {
                setError("Pilih dua dompet berbeda untuk transfer.");
                return;
            }
        }
        if (kind === "refund") {
            if (!originalId) {
                setError("Pilih transaksi pengeluaran asal untuk refund.");
                return;
            }
            payload.original_id = originalId;
        }
        setBusy(true);
        try {
            if (tx) {
                await put("/transactions/" + tx.id, payload);
            } else {
                await post(submitPath || "/transactions", wrap ? wrap(payload) : payload);
            }

            if (wantKeepOpen && !tx && !submitPath) {
                sourceRef.current = crypto.randomUUID();
                const savedLabel = money(numAmount);
                setAmount("");
                setDescription("");
                setFee("0");
                setSplit(false);
                setSplitAmount("");
                setSplitCatId("");
                setScanInfo("");
                setAmountOptions([]);
                setUserPickedCat(false);
                setAutoSuggestedCat(false);
                setSavedFlash(`Tersimpan (${savedLabel}). Lanjut catat transaksi berikutnya!`);
                onSavedKeepOpen?.();
                setTimeout(() => amountInputRef.current?.focus(), 30);
            } else {
                onDone();
            }
        } catch (e) {
            setError(toErr(e));
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
        } catch (e) {
            setError(toErr(e));
        } finally {
            setBusy(false);
        }
    }

    if (!data.accounts.length) return <p className="empty">Buat dompet di Master data terlebih dahulu.</p>;

    const numAmount = parseDigits(amount);
    const numFee = parseDigits(fee);
    const fromAcc = data.accounts.find(a => a.id === accountId);
    const toAcc = data.accounts.find(a => a.id === toAccountId);
    const todayIso = today();
    const yesterdayIso = shiftIsoDays(todayIso, -1);

    const activeAccountAfterBalance =
        fromAcc && fromAcc.balance != null && numAmount > 0
            ? kind === "income" || kind === "refund"
                ? fromAcc.balance + numAmount
                : kind === "expense"
                  ? fromAcc.balance - numAmount
                  : fromAcc.balance - numAmount - numFee
            : null;

    return (
        <form className="form quick-entry-form" onSubmit={submit}>
            {kind === "refund" ? (
                <div className="refund-mode-banner">
                    <span>
                        <RotateCcw size={15} /> Mode <b>Refund Pengeluaran</b>
                    </span>
                    {!tx && (
                        <button
                            type="button"
                            className="btn sm"
                            onClick={() => {
                                setKind("expense");
                                setOriginalId("");
                            }}
                        >
                            <X size={13} /> Kembali ke Pengeluaran
                        </button>
                    )}
                </div>
            ) : (
                <div className="kind-tabs three-tabs" role="tablist" aria-label="Jenis transaksi">
                    {(["expense", "income", "transfer"] as const).map(k => {
                        const Icon = k === "expense" ? ArrowUpRight : k === "income" ? ArrowDownLeft : ArrowLeftRight;
                        return (
                            <button
                                type="button"
                                role="tab"
                                aria-selected={kind === k}
                                key={k}
                                className={`kind-tab ${k} ${kind === k ? "active" : ""}`}
                                onClick={() => {
                                    setKind(k);
                                    if (k === "transfer") setSplit(false);
                                    const validCat = categories.find(
                                        c => c.id === catId && c.kind === (k === "income" ? "income" : "expense")
                                    );
                                    if (!validCat) {
                                        setCatId("");
                                        setUserPickedCat(false);
                                        setAutoSuggestedCat(false);
                                    }
                                }}
                            >
                                <Icon size={15} />
                                <span>{kindLabels[k]}</span>
                            </button>
                        );
                    })}
                </div>
            )}

            {/* Compact Meta Bar: Quick Date + Scan Struk */}
            <div className="entry-meta-strip">
                <div className="quick-date-group">
                    <button
                        type="button"
                        className={"date-chip " + (txDate === todayIso ? "active" : "")}
                        onClick={() => setTxDate(todayIso)}
                    >
                        Hari ini
                    </button>
                    <button
                        type="button"
                        className={"date-chip " + (txDate === yesterdayIso ? "active" : "")}
                        onClick={() => setTxDate(yesterdayIso)}
                    >
                        Kemarin
                    </button>
                    <label className={"date-chip picker " + (txDate !== todayIso && txDate !== yesterdayIso ? "active" : "")}>
                        <span>
                            {txDate !== todayIso && txDate !== yesterdayIso ? shortDate(txDate) : "Pilih tgl"}
                        </span>
                        <input
                            type="date"
                            name="date"
                            aria-label="Tanggal transaksi"
                            value={txDate}
                            onChange={e => e.target.value && setTxDate(e.target.value)}
                            required
                        />
                    </label>
                </div>

                {!tx && !autoScan && (
                    <label className="btn sm scan-compact-btn">
                        <Camera size={14} />
                        <span>{scanning ? "Membaca…" : receiptPreviewUrl ? "Ganti Struk" : "Scan Struk"}</span>
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="image/png,image/jpeg,image/webp"
                            disabled={scanning || busy}
                            onChange={handleReceiptFile}
                        />
                    </label>
                )}
            </div>

            {/* Highlighted Receipt Box only when opened in autoScan mode or actively previewing */}
            {!tx && (autoScan || receiptPreviewUrl || scanning) && (
                <div className={"receipt-autofill " + (autoScan ? "highlighted" : "")}>
                    {receiptPreviewUrl && (
                        <img src={receiptPreviewUrl} alt="Pratinjau struk" className="receipt-thumb" />
                    )}
                    <div className="receipt-autofill-text">
                        <strong>
                            <Sparkles size={15} /> Auto-Fill Struk / Bukti Transfer AI
                        </strong>
                        <small>
                            {scanning
                                ? "Sedang mengenali nominal, dompet, & kategori…"
                                : "Foto struk belanja atau bukti transfer otomatis mengisi form di bawah."}
                        </small>
                    </div>
                    <label className="btn sm receipt-upload-btn">
                        <Camera size={15} />
                        <span>{scanning ? "Membaca…" : receiptPreviewUrl ? "Ganti" : "Pilih Foto"}</span>
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="image/png,image/jpeg,image/webp"
                            disabled={scanning || busy}
                            onChange={handleReceiptFile}
                        />
                    </label>
                </div>
            )}

            {savedFlash && (
                <div className="success">
                    <CheckCircle2 size={17} />
                    <span>{savedFlash}</span>
                </div>
            )}

            {scanInfo && (
                <div className="success">
                    <CheckCircle2 size={17} />
                    <span>{scanInfo}</span>
                </div>
            )}

            {/* 1. HERO NOMINAL */}
            <div className={`amount-hero-box ${kind}`}>
                <div className="amount-hero-top">
                    <span className="amount-hero-label">Nominal {kindLabels[kind]}</span>
                    {numAmount > 0 && (
                        <button
                            type="button"
                            className="amount-clear-btn"
                            onClick={() => {
                                setAmount("");
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
                        onChange={e => setAmount(e.target.value.replace(/\D/g, ""))}
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
                            onClick={() => setAmount(String(numAmount * 1000))}
                        >
                            .000
                        </button>
                    )}
                    {[15000, 25000, 50000, 100000, 250000].map(preset => (
                        <button
                            key={preset}
                            type="button"
                            className={"nominal-chip " + (numAmount === preset ? "active" : "")}
                            onClick={() => setAmount(String(preset))}
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
                                    onClick={() => setAmount(String(val))}
                                >
                                    {money(val)}
                                </button>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {/* 2 & 3. CATEGORY + WALLET */}
            {kind === "transfer" ? (
                <div className="transfer-box">
                    <div className="transfer-wallets-grid">
                        <div className="field">
                            <span>Dari Dompet Asal</span>
                            <div className="wallet-chip-grid">
                                {data.accounts.map(a => (
                                    <button
                                        type="button"
                                        key={a.id}
                                        className={"wallet-pick-card " + (accountId === a.id ? "active" : "")}
                                        onClick={() => {
                                            setAccountId(a.id);
                                            if (a.id === toAccountId) {
                                                const alt = data.accounts.find(x => x.id !== a.id);
                                                if (alt) setToAccountId(alt.id);
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
                                setAccountId(toAccountId);
                                setToAccountId(prevFrom);
                            }}
                        >
                            <ArrowLeftRight size={18} />
                        </button>

                        <div className="field">
                            <span>Ke Dompet Tujuan</span>
                            <div className="wallet-chip-grid">
                                {data.accounts.map(a => (
                                    <button
                                        type="button"
                                        key={a.id}
                                        className={"wallet-pick-card to " + (toAccountId === a.id ? "active" : "")}
                                        onClick={() => {
                                            setToAccountId(a.id);
                                            if (a.id === accountId) {
                                                const alt = data.accounts.find(x => x.id !== a.id);
                                                if (alt) setAccountId(alt.id);
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
                                onChange={e => setFee(e.target.value.replace(/\D/g, ""))}
                                placeholder="0"
                            />
                        </Field>
                        <div className="quick-nominal-row fee-presets">
                            {[0, 1000, 2500, 6500].map(f => (
                                <button
                                    key={f}
                                    type="button"
                                    className={"nominal-chip " + (numFee === f ? "active" : "")}
                                    onClick={() => setFee(String(f))}
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
            ) : (
                <>
                    {kind === "refund" ? (
                        <Field label="Transaksi pengeluaran asal yang di-refund">
                            <select
                                name="original_id"
                                required
                                value={originalId}
                                onChange={e => setOriginalId(e.target.value)}
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
                            transactions={data.transactions}
                            kind={kind === "income" ? "income" : "expense"}
                            value={catId}
                            autoSuggested={autoSuggestedCat && !userPickedCat}
                            disabled={busy}
                            onChange={(nextId, manual) => {
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
                            {data.accounts.map(a => (
                                <button
                                    type="button"
                                    key={a.id}
                                    className={"wallet-pick-card " + (accountId === a.id ? "active" : "")}
                                    onClick={() => setAccountId(a.id)}
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
            )}

            {/* 4. CATATAN SINGKAT */}
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

            {/* COLLAPSIBLE ADVANCED OPTIONS */}
            {kind !== "transfer" && kind !== "refund" && (
                <div className="advanced-toggle-box">
                    <button
                        type="button"
                        className="advanced-toggle-btn"
                        onClick={() => setShowAdvanced(v => !v)}
                    >
                        <SlidersHorizontal size={13} />
                        <span>Opsi lanjutan (Split kategori{!tx ? " / Refund" : ""})</span>
                        {showAdvanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    </button>

                    {showAdvanced && (
                        <div className="advanced-panel">
                            <label className="check">
                                <input type="checkbox" checked={split} onChange={e => setSplit(e.target.checked)} />
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
                                            onChange={e => setSplitAmount(e.target.value.replace(/\D/g, ""))}
                                            required
                                        />
                                    </Field>
                                    <Field label="Kategori kedua (sisa nominal)">
                                        <select
                                            name="split_cat"
                                            value={splitCatId}
                                            onChange={e => setSplitCatId(e.target.value)}
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

                            {!tx && !submitPath && (
                                <button
                                    type="button"
                                    className="btn sm"
                                    style={{ justifySelf: "start" }}
                                    onClick={() => {
                                        setSplit(false);
                                        setKind("refund");
                                    }}
                                >
                                    <RotateCcw size={13} /> Ubah ke pencatatan Refund pengeluaran
                                </button>
                            )}
                        </div>
                    )}
                </div>
            )}

            <ErrorNote message={error} />

            {/* STICKY FOOTER SUBMIT */}
            <div className="entry-sticky-footer">
                <button type="submit" disabled={busy || scanning} className="btn primary entry-submit-main">
                    {busy
                        ? "Menyimpan…"
                        : tx
                          ? "Simpan perubahan"
                          : `Simpan ${kindLabels[kind]}${numAmount > 0 ? ` · ${money(numAmount)}` : ""}`}
                </button>
                {!tx && !submitPath && onSavedKeepOpen && (
                    <button
                        type="submit"
                        disabled={busy || scanning}
                        className="btn"
                        title="Simpan lalu langsung catat transaksi berikutnya"
                        onClick={() => {
                            keepOpenAfterSubmit.current = true;
                        }}
                    >
                        <Plus size={15} /> Simpan &amp; Lagi
                    </button>
                )}
                {tx && !confirmDelete && (
                    <button
                        type="button"
                        className="btn danger-outline"
                        disabled={busy}
                        onClick={() => setConfirmDelete(true)}
                    >
                        <Trash2 size={15} /> Hapus
                    </button>
                )}
            </div>

            {tx && confirmDelete && (
                <div className="danger-box">
                    <strong>Hapus transaksi ini ({money(tx.amount)})?</strong>
                    <p className="muted">Saldo dompet dan perhitungan laporan akan otomatis diperbarui.</p>
                    <div className="btns">
                        <button type="button" className="btn danger" disabled={busy} onClick={removeTx}>
                            Ya, hapus
                        </button>
                        <button type="button" className="btn" disabled={busy} onClick={() => setConfirmDelete(false)}>
                            Batal
                        </button>
                    </div>
                </div>
            )}
        </form>
    );
}
