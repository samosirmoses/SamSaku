"use client";
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import {
    ArrowDownLeft,
    ArrowLeftRight,
    ArrowRight,
    ArrowUpRight,
    Camera,
    CheckCircle2,
    Plus,
    RotateCcw,
    Sparkles,
    Trash2,
} from "lucide-react";
import { CatIcon, ErrorNote, Field, WalletIcon } from "../../components/ui";
import { del, get, post, put, request } from "../../lib/api";
import {
    type Data,
    type Transaction,
    formatDots,
    inferCategoryClient,
    kindLabels,
    money,
    parseDigits,
    today,
} from "../../lib/domain";

const toErr = (e: unknown) => (e instanceof Error ? e.message : "Gagal menyimpan perubahan.");

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
                const guessNote = res.account_guessed ? " (dompet asal perkiraan)" : "";
                setScanInfo(
                    `Terdeteksi: Transfer · ${fromLabel} → ${toLabel}${feeNote}${guessNote} · Tanggal: ${res.date || today()}`
                );
            } else {
                setFee("0");
                const autoCat =
                    res.category_id ||
                    (detectedKind === "expense"
                        ? inferCategoryClient(res.merchant || file.name, categories, data.transactions)
                        : "");
                if (autoCat) setCatId(autoCat);
                const catLabel = res.category_name || categories.find(c => c.id === autoCat)?.name || "Otomatis";
                const typeTag = res.transaction_type ? ` (${res.transaction_type})` : "";
                const guessNote = res.account_guessed ? " · Dompet perkiraan" : "";
                setScanInfo(
                    `Terdeteksi: ${kindLabels[detectedKind]}${typeTag} · Kategori: ${catLabel}${guessNote} · Tanggal: ${res.date || today()}`
                );
            }
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
            setError(scanErr instanceof Error ? scanErr.message : "");
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
            setError(toErr(e));
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

    return (
        <form className="form" onSubmit={submit}>
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

            {!tx && (
                <div className={"receipt-autofill " + (autoScan ? "highlighted" : "")}>
                    {receiptPreviewUrl && (
                        <img src={receiptPreviewUrl} alt="Pratinjau struk" className="receipt-thumb" />
                    )}
                    <div className="receipt-autofill-text">
                        <strong>
                            <Sparkles size={15} /> Auto-Fill dari Foto Struk / Bukti Transfer
                        </strong>
                        <small>
                            {scanning
                                ? "Sedang membaca jenis transaksi, berita, nominal, dompet & kategori…"
                                : "Unggah struk belanja atau bukti transfer BCA — otomatis kenali pengeluaran, pemasukan, atau transfer antar dompet."}
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

            <div className={`amount-hero-box ${kind}`}>
                <div className="amount-hero-top">
                    <span className="amount-hero-label">Nominal {kindLabels[kind]}</span>
                    {numAmount > 0 && (
                        <button type="button" className="amount-clear-btn" onClick={() => setAmount("")}>
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
                        placeholder={kind === "transfer" ? "Contoh: Top up GoPay" : "Contoh: Kopi Tuku, Indomaret"}
                    />
                </Field>
                <Field label="Tanggal transaksi">
                    <input type="date" name="date" value={txDate} onChange={e => setTxDate(e.target.value)} required />
                </Field>
            </div>

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

                    {fromAcc && toAcc && numAmount > 0 && (
                        <div className="transfer-sim-card">
                            <small className="muted">Simulasi saldo setelah transfer:</small>
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
                                    <button
                                        className="btn primary sm"
                                        type="button"
                                        disabled={busy}
                                        onClick={addCategory}
                                    >
                                        Simpan kategori
                                    </button>
                                </div>
                            )}
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
