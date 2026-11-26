"use client";
import { useState, useEffect, useRef, type FormEvent, type ChangeEvent } from "react";
import {
    ArrowDownLeft,
    ArrowLeftRight,
    ArrowRight,
    ArrowUpRight,
    Camera,
    CheckCircle2,
    Coins,
    Landmark,
    Plus,
    RotateCcw,
    Smartphone,
    Sparkles,
    Trash2,
} from "lucide-react";
import { del, get, patch, post, put, request } from "../lib/api";
import {
    type Account,
    type Data,
    type Transaction,
    inferCategoryClient,
    kindLabels,
    money,
    today,
} from "../lib/domain";
import { CatIcon, ErrorNote, Field } from "./ui";

const err = (e: unknown) => (e instanceof Error ? e.message : "Gagal menyimpan perubahan.");

type ScanResult = {
    merchant?: string;
    merchant_name?: string;
    items?: string[];
    amount?: number | null;
    amount_options?: number[];
    date?: string | null;
    category_id?: string | null;
    category_name?: string | null;
    engine?: string;
};

function formatDots(val: string | number): string {
    const digits = String(val).replace(/\D/g, "");
    if (!digits) return "";
    return Number(digits).toLocaleString("id-ID");
}

function parseDigits(val: string): number {
    const digits = val.replace(/\D/g, "");
    return digits ? Number(digits) : 0;
}

function WalletIcon({ kind, name, size = 17 }: { kind?: string; name: string; size?: number }) {
    const Icon =
        kind === "bank" || /bca|bank|mandiri|bri|bni|jago|cimb/i.test(name)
            ? Landmark
            : kind === "cash" || /tunai|cash|kas/i.test(name)
              ? Coins
              : Smartphone;
    return <Icon size={size} />;
}

export function MasterForm({
    mode,
    data,
    account,
    onDone,
}: {
    mode: "account" | "category";
    data: Data;
    account?: Account | null;
    onDone: () => void;
}) {
    const isEditAccount = mode === "account" && !!account;
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [kind, setKind] = useState<"expense" | "income">("expense");
    const [name, setName] = useState(account?.name || "");
    const [code, setCode] = useState(account?.code || "");
    const [accountKind, setAccountKind] = useState(account?.kind || "bank");
    const [openingBalance, setOpeningBalance] = useState(
        account?.opening_balance != null ? String(account.opening_balance) : "0"
    );
    const [openingDate, setOpeningDate] = useState(account?.opening_date || today());
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [deleteMode, setDeleteMode] = useState<"transfer" | "cascade">("transfer");
    const otherAccounts = data.accounts.filter(a => a.id !== account?.id);
    const [transferTo, setTransferTo] = useState(otherAccounts[0]?.id || "");

    const txCount =
        account?.tx_count ??
        (account
            ? data.transactions.filter(t => t.account_id === account.id || t.to_account_id === account.id).length
            : 0);

    async function submit(e: FormEvent<HTMLFormElement>) {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        setBusy(true);
        setError("");
        const cleanName = name.trim();
        try {
            const cleanCode =
                (code || cleanName)
                    .trim()
                    .toUpperCase()
                    .replace(/[^A-Z0-9_-]+/g, "-")
                    .slice(0, 48) || "ITEM";
            if (mode === "category") {
                await post("/categories", {
                    code: cleanCode,
                    name: cleanName,
                    kind,
                    parent_id: f.get("parent_id") || null,
                });
            } else if (isEditAccount && account) {
                const rawBal = openingBalance.trim();
                const hasOpening = rawBal !== "" && openingDate.trim() !== "";
                await patch("/accounts/" + account.id, {
                    code: cleanCode,
                    name: cleanName,
                    kind: accountKind,
                    opening_date: hasOpening ? openingDate : null,
                    opening_balance: hasOpening ? parseDigits(rawBal) : null,
                    clear_opening: !hasOpening,
                });
            } else {
                const rawBal = openingBalance.trim();
                const hasOpening = rawBal !== "";
                await post("/accounts", {
                    code: cleanCode,
                    name: cleanName,
                    kind: accountKind,
                    opening_date: hasOpening ? openingDate || today() : null,
                    opening_balance: hasOpening ? parseDigits(rawBal) : null,
                });
            }
            onDone();
        } catch (e) {
            setError(err(e));
        } finally {
            setBusy(false);
        }
    }

    async function removeAccount() {
        if (!account) return;
        setBusy(true);
        setError("");
        try {
            const params = new URLSearchParams();
            if (txCount > 0) {
                if (deleteMode === "transfer" && otherAccounts.length > 0) {
                    if (!transferTo) throw new Error("Pilih dompet tujuan pemindahan transaksi.");
                    params.set("transfer_to", transferTo);
                } else {
                    params.set("cascade", "true");
                }
            } else {
                params.set("cascade", "true");
            }
            const qs = params.toString() ? "?" + params.toString() : "";
            await del("/accounts/" + account.id + qs);
            onDone();
        } catch (e) {
            setError(err(e));
        } finally {
            setBusy(false);
        }
    }

    return (
        <form onSubmit={submit} className="form">
            {mode === "account" && (
                <div className="field">
                    <span>Jenis dompet</span>
                    <div className="selector-grid three">
                        {[
                            { id: "bank", label: "Rekening Bank", icon: Landmark },
                            { id: "ewallet", label: "E-Wallet", icon: Smartphone },
                            { id: "cash", label: "Uang Tunai", icon: Coins },
                        ].map(item => {
                            const Icon = item.icon;
                            return (
                                <button
                                    type="button"
                                    key={item.id}
                                    className={"selector-card " + (accountKind === item.id ? "active" : "")}
                                    onClick={() => setAccountKind(item.id)}
                                >
                                    <Icon size={18} />
                                    <strong>{item.label}</strong>
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}

            {mode === "category" && (
                <div className="field">
                    <span>Jenis kategori</span>
                    <div className="selector-grid two">
                        <button
                            type="button"
                            className={"selector-card expense " + (kind === "expense" ? "active" : "")}
                            onClick={() => setKind("expense")}
                        >
                            <ArrowUpRight size={18} />
                            <strong>Pengeluaran</strong>
                        </button>
                        <button
                            type="button"
                            className={"selector-card income " + (kind === "income" ? "active" : "")}
                            onClick={() => setKind("income")}
                        >
                            <ArrowDownLeft size={18} />
                            <strong>Pemasukan</strong>
                        </button>
                    </div>
                </div>
            )}

            <Field label={mode === "account" ? "Nama dompet" : "Nama kategori"}>
                <input
                    autoFocus
                    name="name"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    required
                    maxLength={90}
                    placeholder={mode === "account" ? "Misal: myBCA, GoPay, Tunai" : "Misal: Makan & Minum"}
                />
            </Field>

            {mode === "category" && (
                <Field label="Kategori induk (opsional)">
                    <select name="parent_id" key={kind}>
                        <option value="">Tanpa induk (Kategori utama)</option>
                        {data.categories
                            .filter(c => c.kind === kind && !c.archived && !c.parent_id)
                            .map(c => (
                                <option key={c.id} value={c.id}>
                                    {c.name}
                                </option>
                            ))}
                    </select>
                </Field>
            )}

            {mode === "account" && (
                <>
                    <div className="amount-hero-box">
                        <span className="amount-hero-label">Saldo Awal Dompet</span>
                        <div className="amount-hero-input-row">
                            <span className="currency-prefix">Rp</span>
                            <input
                                type="text"
                                inputMode="numeric"
                                aria-label="Saldo awal"
                                value={formatDots(openingBalance)}
                                onChange={e => {
                                    const raw = e.target.value.replace(/\D/g, "");
                                    setOpeningBalance(raw);
                                    if (raw && !openingDate) setOpeningDate(today());
                                }}
                                placeholder="0"
                            />
                        </div>
                        <div className="quick-nominal-row">
                            {[0, 500000, 1000000, 5000000, 10000000].map(v => (
                                <button
                                    key={v}
                                    type="button"
                                    className="nominal-chip"
                                    onClick={() => setOpeningBalance(String(v))}
                                >
                                    {v === 0 ? "Rp 0" : `+${v >= 1000000 ? v / 1000000 + "jt" : v / 1000 + "rb"}`}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="form-pair">
                        <Field label="Tanggal saldo awal">
                            <input
                                type="date"
                                name="opening_date"
                                value={openingDate}
                                onChange={e => setOpeningDate(e.target.value)}
                            />
                        </Field>
                        <Field label="Kode dompet (opsional)">
                            <input
                                name="code"
                                value={code}
                                onChange={e => setCode(e.target.value)}
                                placeholder="Otomatis"
                            />
                        </Field>
                    </div>
                </>
            )}

            <ErrorNote message={error} />

            <div className="btns">
                <button type="submit" className="btn primary" disabled={busy}>
                    {busy ? "Menyimpan…" : isEditAccount ? "Simpan perubahan" : "Simpan"}
                </button>
                {isEditAccount && !confirmDelete && (
                    <button
                        type="button"
                        className="btn danger-outline"
                        disabled={busy}
                        onClick={() => {
                            setConfirmDelete(true);
                            if (!otherAccounts.length) setDeleteMode("cascade");
                        }}
                    >
                        <Trash2 size={15} /> Hapus dompet
                    </button>
                )}
            </div>

            {isEditAccount && confirmDelete && (
                <div className="danger-box">
                    <strong>Hapus dompet &ldquo;{account?.name}&rdquo;?</strong>
                    {txCount > 0 ? (
                        <>
                            <p className="muted">
                                Dompet ini memiliki <b>{txCount} transaksi</b>. Pilih perlakuan untuk transaksi yang
                                ada:
                            </p>
                            {otherAccounts.length > 0 && (
                                <label className="check">
                                    <input
                                        type="radio"
                                        name="del_mode"
                                        checked={deleteMode === "transfer"}
                                        onChange={() => setDeleteMode("transfer")}
                                    />
                                    <span>Pindahkan semua transaksi ke dompet lain</span>
                                </label>
                            )}
                            {deleteMode === "transfer" && otherAccounts.length > 0 && (
                                <Field label="Dompet tujuan">
                                    <select value={transferTo} onChange={e => setTransferTo(e.target.value)}>
                                        {otherAccounts.map(a => (
                                            <option key={a.id} value={a.id}>
                                                {a.name}
                                            </option>
                                        ))}
                                    </select>
                                </Field>
                            )}
                            <label className="check">
                                <input
                                    type="radio"
                                    name="del_mode"
                                    checked={deleteMode === "cascade"}
                                    onChange={() => setDeleteMode("cascade")}
                                />
                                <span>Hapus dompet beserta seluruh transaksinya</span>
                            </label>
                        </>
                    ) : (
                        <p className="muted">Dompet ini belum memiliki transaksi dan dapat langsung dihapus.</p>
                    )}
                    <div className="btns">
                        <button type="button" className="btn danger" disabled={busy} onClick={removeAccount}>
                            Ya, hapus dompet
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

export function EntryForm({
    data,
    onDone,
    tx,
    autoScan = false,
    submitPath,
    wrap,
    initial = {},
}: {
    data: Data;
    onDone: () => void;
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
    const [splitAmount, setSplitAmount] = useState<string>(
        hasExistingSplits && tx?.splits?.[0] ? String(Math.abs(tx.splits[0].amount)) : ""
    );
    const [splitCatId, setSplitCatId] = useState<string>(
        hasExistingSplits && tx?.splits?.[1] ? tx.splits[1].category_id || "" : ""
    );

    const [categories, setCategories] = useState(data.categories);
    const [inline, setInline] = useState(false);
    const [newName, setNewName] = useState("");
    const [expenses, setExpenses] = useState(data.transactions.filter(t => t.kind === "expense" && t.id !== tx?.id));
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [scanning, setScanning] = useState(false);
    const [scanInfo, setScanInfo] = useState<string>("");
    const [receiptPreviewUrl, setReceiptPreviewUrl] = useState<string>("");
    const [amountOptions, setAmountOptions] = useState<number[]>([]);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const sourceRef = useRef("");

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
        setAmountOptions([]);
        try {
            const form = new FormData();
            form.append("file", file);
            const res = (await request("/receipts/scan", { method: "POST", body: form })) as ScanResult;
            setKind("expense");
            if (res.amount) setAmount(String(res.amount));
            if (res.amount_options && res.amount_options.length > 1) setAmountOptions(res.amount_options);
            if (res.date) setTxDate(res.date);
            if (res.merchant) setDescription(res.merchant);
            const autoCat =
                res.category_id ||
                inferCategoryClient(res.merchant || file.name, categories, data.transactions);
            if (autoCat) setCatId(autoCat);
            const catLabel =
                res.category_name || categories.find(c => c.id === autoCat)?.name || "Otomatis";
            const engineLabel = res.engine === "gemini" ? "AI Vision" : "OCR Lokal";
            setScanInfo(
                `Struk terbaca (${engineLabel}) · Kategori: ${catLabel} · Tanggal: ${res.date || today()}`
            );
        } catch (scanErr) {
            const cleanName = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
            const numMatch = cleanName.match(/(\d{2,9})/);
            setKind("expense");
            if (cleanName) setDescription(cleanName);
            if (numMatch) setAmount(numMatch[1]);
            const autoCat = inferCategoryClient(cleanName, categories, data.transactions);
            if (autoCat) setCatId(autoCat);
            setScanInfo(
                `Kategori (${categories.find(c => c.id === autoCat)?.name || "Pengeluaran"}) & tanggal terisi otomatis. Silakan konfirmasi nominal.`
            );
            if (!(scanErr instanceof Error && (scanErr.message.includes("503") || scanErr.message.includes("OCR")))) {
                setError(scanErr instanceof Error ? scanErr.message : "");
            }
        } finally {
            setScanning(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    }

    async function addCategory() {
        const name = newName.trim();
        if (!name) return;
        setBusy(true);
        setError("");
        try {
            const c = await post<Data["categories"][number]>("/categories", {
                name,
                code: name.toUpperCase().replace(/[^A-Z0-9]+/g, "-") || "CAT",
                kind: kind === "income" ? "income" : "expense",
            });
            setCategories(v => [...v, c]);
            setCatId(c.id);
            setInline(false);
            setNewName("");
        } catch (e) {
            setError(err(e));
        } finally {
            setBusy(false);
        }
    }

    async function submit(e: FormEvent<HTMLFormElement>) {
        e.preventDefault();
        const numAmount = parseDigits(amount);
        if (!numAmount || numAmount <= 0) {
            setError("Masukkan nominal transaksi yang valid.");
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
            onDone();
        } catch (e) {
            setError(err(e));
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
            setError(err(e));
        } finally {
            setBusy(false);
        }
    }

    if (!data.accounts.length) return <p className="empty">Buat dompet di Master data terlebih dahulu.</p>;

    const numAmount = parseDigits(amount);
    const numFee = parseDigits(fee);
    const fromAcc = data.accounts.find(a => a.id === accountId);
    const toAcc = data.accounts.find(a => a.id === toAccountId);

    return (
        <form className="form" onSubmit={submit}>
            {/* Segmented Kind Selector */}
            <div className="kind-tabs" role="tablist" aria-label="Jenis transaksi">
                {(["expense", "income", "transfer", "refund"] as const).map(k => {
                    const Icon =
                        k === "expense"
                            ? ArrowUpRight
                            : k === "income"
                              ? ArrowDownLeft
                              : k === "transfer"
                                ? ArrowLeftRight
                                : RotateCcw;
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
                                if (!validCat) setCatId("");
                            }}
                        >
                            <Icon size={15} />
                            <span>{kindLabels[k]}</span>
                        </button>
                    );
                })}
            </div>

            {/* Instant Receipt Auto-Fill Scanner with Thumbnail Preview */}
            {kind === "expense" && !tx && (
                <div className={"receipt-autofill " + (autoScan ? "highlighted" : "")}>
                    {receiptPreviewUrl && (
                        <img
                            src={receiptPreviewUrl}
                            alt="Pratinjau struk"
                            className="receipt-thumb"
                        />
                    )}
                    <div className="receipt-autofill-text">
                        <strong>
                            <Sparkles size={15} /> Auto-Fill dari Foto Struk
                        </strong>
                        <small>
                            {scanning
                                ? "Sedang mengekstrak nominal, tanggal, merchant & kategori…"
                                : "Unggah atau foto struk belanja agar form otomatis terisi tanpa ketik manual."}
                        </small>
                    </div>
                    <label className="btn receipt-upload-btn">
                        <Camera size={16} />
                        <span>{scanning ? "Membaca…" : receiptPreviewUrl ? "Ganti Foto" : "Foto Struk"}</span>
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

            {scanInfo && (
                <div className="success">
                    <CheckCircle2 size={17} />
                    <span>{scanInfo}</span>
                </div>
            )}

            {/* Hero Formatted Rupiah Nominal Input + Quick Add Chips */}
            <div className={`amount-hero-box ${kind}`}>
                <div className="amount-hero-top">
                    <span className="amount-hero-label">Nominal {kindLabels[kind]}</span>
                    {numAmount > 0 && (
                        <button
                            type="button"
                            className="amount-clear-btn"
                            onClick={() => setAmount("")}
                        >
                            Reset
                        </button>
                    )}
                </div>
                <div className="amount-hero-input-row">
                    <span className="currency-prefix">
                        {kind === "income" || kind === "refund" ? "+Rp" : kind === "transfer" ? "⇄ Rp" : "−Rp"}
                    </span>
                    <input
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
                    {[10000, 25000, 50000, 100000, 500000].map(step => (
                        <button
                            key={step}
                            type="button"
                            className="nominal-chip"
                            onClick={() => setAmount(String(numAmount + step))}
                        >
                            +{step / 1000}rb
                        </button>
                    ))}
                </div>
                {amountOptions.length > 1 && (
                    <div className="amount-chips" style={{ marginTop: 8 }}>
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

            {/* Date & Description Row */}
            <div className="form-pair">
                <Field label="Keterangan / Merchant">
                    <input
                        name="description"
                        value={description}
                        onChange={e => {
                            const val = e.target.value;
                            setDescription(val);
                            if (!catId && kind === "expense" && val.length >= 3) {
                                const guessed = inferCategoryClient(val, categories, data.transactions);
                                if (guessed) setCatId(guessed);
                            }
                        }}
                        placeholder={
                            kind === "transfer" ? "Contoh: Top up GoPay" : "Contoh: Kopi Tuku, Indomaret"
                        }
                    />
                </Field>
                <Field label="Tanggal transaksi">
                    <input
                        type="date"
                        name="date"
                        value={txDate}
                        onChange={e => setTxDate(e.target.value)}
                        required
                    />
                </Field>
            </div>

            {/* TRANSFER FLOW: Visual Dual Wallet Selector + 1-Click Swap + Balance Simulator */}
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

                    <Field label="Biaya admin transfer (Rp, opsional)">
                        <input
                            type="text"
                            inputMode="numeric"
                            name="fee"
                            value={formatDots(fee)}
                            onChange={e => setFee(e.target.value.replace(/\D/g, ""))}
                            placeholder="0"
                        />
                    </Field>

                    {/* Live Transfer Balance Simulation Preview */}
                    {fromAcc && toAcc && numAmount > 0 && (
                        <div className="transfer-sim-card">
                            <small className="muted">Simulasi saldo setelah transfer:</small>
                            <div className="transfer-sim-row">
                                <span>
                                    <b>{fromAcc.name}</b>
                                </span>
                                <span>
                                    {money(fromAcc.balance || 0)} <ArrowRight size={13} />{" "}
                                    <b className="expense-amt">
                                        {money((fromAcc.balance || 0) - numAmount - numFee)}
                                    </b>
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
                    {/* 1-CLICK WALLET CHIP SELECTOR */}
                    <div className="field">
                        <span>Pilih Dompet</span>
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

                    {/* 1-CLICK CATEGORY CHIP SELECTOR OR REFUND ORIGINAL TX */}
                    {kind === "refund" ? (
                        <Field label="Transaksi pengeluaran asal">
                            <select
                                name="original_id"
                                required
                                value={originalId}
                                onChange={e => setOriginalId(e.target.value)}
                            >
                                <option value="">Pilih pengeluaran</option>
                                {expenses.map(t => (
                                    <option key={t.id} value={t.id}>
                                        {t.date} · {t.description || "Pengeluaran"} · {money(t.amount)}
                                    </option>
                                ))}
                            </select>
                        </Field>
                    ) : (
                        <div className="field">
                            <span>Pilih Kategori</span>
                            <div className="cat-chip-grid">
                                {cats.map(c => (
                                    <button
                                        type="button"
                                        key={c.id}
                                        className={`cat-pick-chip ${kind} ${catId === c.id ? "active" : ""}`}
                                        onClick={() => setCatId(catId === c.id ? "" : c.id)}
                                    >
                                        <CatIcon name={c.name} size={15} />
                                        <span>
                                            {c.parent_id ? "↳ " : ""}
                                            {c.name}
                                        </span>
                                    </button>
                                ))}
                                <button
                                    type="button"
                                    className="cat-pick-chip add-new"
                                    onClick={() => setInline(v => !v)}
                                >
                                    <Plus size={15} />
                                    <span>Kategori baru</span>
                                </button>
                            </div>
                        </div>
                    )}

                    {kind !== "refund" && (
                        <>
                            {inline && (
                                <div className="inline-add">
                                    <input
                                        aria-label="Nama kategori baru"
                                        value={newName}
                                        onChange={e => setNewName(e.target.value)}
                                        placeholder="Ketik nama kategori baru…"
                                    />
                                    <button className="btn primary sm" type="button" disabled={busy} onClick={addCategory}>
                                        Simpan kategori
                                    </button>
                                </div>
                            )}
                            <label className="check">
                                <input
                                    type="checkbox"
                                    checked={split}
                                    onChange={e => setSplit(e.target.checked)}
                                />
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
                        </>
                    )}
                </>
            )}

            <ErrorNote message={error} />

            <div className="btns">
                <button type="submit" disabled={busy || scanning} className="btn primary">
                    {busy ? "Menyimpan…" : tx ? "Simpan perubahan" : "Simpan transaksi"}
                </button>
                {tx && !confirmDelete && (
                    <button
                        type="button"
                        className="btn danger-outline"
                        disabled={busy}
                        onClick={() => setConfirmDelete(true)}
                    >
                        <Trash2 size={15} /> Hapus transaksi
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
