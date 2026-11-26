"use client";
import { useState, type FormEvent } from "react";
import { ArrowDownLeft, ArrowUpRight, Coins, Landmark, Smartphone, Trash2 } from "lucide-react";
import { ErrorNote, Field } from "../../components/ui";
import { del, patch, post } from "../../lib/api";
import { type Account, type Data, formatDots, parseDigits, today } from "../../lib/domain";

const toErr = (e: unknown) => (e instanceof Error ? e.message : "Gagal menyimpan perubahan.");

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
    const [accountNumber, setAccountNumber] = useState(account?.account_number || "");
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
                const cleanAccNo = accountNumber.replace(/[\s.\-]+/g, "").trim();
                await patch("/accounts/" + account.id, {
                    code: cleanCode,
                    name: cleanName,
                    kind: accountKind,
                    account_number: cleanAccNo || null,
                    opening_date: hasOpening ? openingDate : null,
                    opening_balance: hasOpening ? parseDigits(rawBal) : null,
                    clear_opening: !hasOpening,
                });
            } else {
                const rawBal = openingBalance.trim();
                const hasOpening = rawBal !== "";
                const cleanAccNo = accountNumber.replace(/[\s.\-]+/g, "").trim();
                await post("/accounts", {
                    code: cleanCode,
                    name: cleanName,
                    kind: accountKind,
                    account_number: cleanAccNo || null,
                    opening_date: hasOpening ? openingDate || today() : null,
                    opening_balance: hasOpening ? parseDigits(rawBal) : null,
                });
            }
            onDone();
        } catch (e) {
            setError(toErr(e));
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
            if (txCount > 0 && deleteMode === "transfer" && otherAccounts.length > 0) {
                if (!transferTo) throw new Error("Pilih dompet tujuan pemindahan transaksi.");
                params.set("transfer_to", transferTo);
            } else {
                params.set("cascade", "true");
            }
            const qs = params.toString() ? "?" + params.toString() : "";
            await del("/accounts/" + account.id + qs);
            onDone();
        } catch (e) {
            setError(toErr(e));
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

                    {accountKind !== "cash" && (
                        <Field label="Nomor Rekening / No. HP (opsional)">
                            <input
                                name="account_number"
                                inputMode="numeric"
                                value={accountNumber}
                                onChange={e => setAccountNumber(e.target.value.replace(/[^\d\s.-]/g, ""))}
                                maxLength={28}
                                placeholder={
                                    accountKind === "ewallet"
                                        ? "Misal: 081234567890 (atau 4–10 digit terakhir)"
                                        : "Misal: 1234567890 (atau 4–10 digit terakhir)"
                                }
                            />
                            <small className="muted">
                                Dipakai untuk deteksi otomatis transfer antar dompet &amp; sumber dana dari foto bukti
                                transaksi.
                            </small>
                        </Field>
                    )}
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
