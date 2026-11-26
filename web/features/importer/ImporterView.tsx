"use client";
import { useEffect, useState } from "react";
import { CheckCircle2, ChevronDown, Download, FileSpreadsheet, Upload } from "lucide-react";
import { ErrorNote, Field } from "../../components/ui";
import { download, get, post, request } from "../../lib/api";
import { type Data, money } from "../../lib/domain";

const ENTITY_FIELDS: Record<string, string[]> = {
    transactions: [
        "date",
        "kind",
        "account",
        "amount",
        "debit",
        "credit",
        "description",
        "category",
        "to_account",
        "fee",
        "reference",
        "merchant",
        "original_ref",
    ],
    accounts: ["code", "name", "kind", "opening_date", "opening_balance"],
    categories: ["code", "name", "kind", "parent"],
    merchants: ["code", "name"],
    aliases: ["name", "merchant"],
};

const FIELD_LABELS: Record<string, string> = {
    transactions: "Transaksi",
    accounts: "Dompet",
    categories: "Kategori",
    merchants: "Merchant",
    aliases: "Alias merchant",
    date: "Tanggal",
    kind: "Jenis",
    account: "Dompet",
    amount: "Nominal",
    debit: "Debit",
    credit: "Kredit",
    description: "Keterangan",
    category: "Kategori",
    to_account: "Dompet tujuan",
    fee: "Biaya",
    reference: "Referensi",
    merchant: "Merchant",
    original_ref: "Referensi asal",
    code: "Kode",
    name: "Nama",
    opening_date: "Tanggal saldo awal",
    opening_balance: "Saldo awal",
    parent: "Induk",
};

const STATUS_LABELS: Record<string, string> = {
    new: "Baru",
    update: "Diperbarui",
    duplicate: "Sudah ada",
    similar: "Mirip",
    error: "Periksa",
    done: "Selesai",
    uploaded: "Diunggah",
    preview: "Pratinjau",
    expired: "Kedaluwarsa",
};

type SheetSample = { name: string; headers: string[]; sample: unknown[][] };
type SheetConfig = {
    name: string;
    entity: string;
    header_row: number;
    mapping: Record<string, string>;
    date_order: string;
    default_account: string;
    enabled: boolean;
    categories?: Record<string, string>;
};
type UploadBatch = { id: string; sheets: SheetSample[]; kind: string };
type PreviewRow = {
    sheet: string;
    row: number;
    status: string;
    message: string;
    changes?: Record<string, { from: string; to: string }>;
    values: Record<string, unknown>;
};
type PreviewResult = {
    rows: PreviewRow[];
    counts: Record<string, number>;
    income: number;
    expense: number;
    impacts: Record<string, number>;
    date_start?: string;
    date_end?: string;
    revision: string;
};
type SavedMapping = { mapping_name: string; sheets: SheetConfig[] };
type ImportHistoryItem = { id: string; kind: string; filename: string; status: string };

const rowKey = (r: PreviewRow) => `${r.sheet}/${r.row}`;
const needsAttention = (r: PreviewRow) => ["error", "similar", "conflict"].includes(r.status);

export function ImporterView({
    data,
    demoMode,
    onLogin,
    onDone,
}: {
    data: Data;
    demoMode: boolean;
    onLogin: () => void;
    onDone: () => void;
}) {
    const [kind, setKind] = useState("transactions");
    const [batch, setBatch] = useState<UploadBatch | null>(null);
    const [configs, setConfigs] = useState<SheetConfig[]>([]);
    const [preview, setPreview] = useState<PreviewResult | null>(null);
    const [excluded, setExcluded] = useState<string[]>([]);
    const [accepted, setAccepted] = useState<string[]>([]);
    const [doneMessage, setDoneMessage] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [file, setFile] = useState<File | null>(null);
    const [history, setHistory] = useState<ImportHistoryItem[]>([]);
    const [savedMaps, setSavedMaps] = useState<SavedMapping[]>([]);
    const [mappingName, setMappingName] = useState("");
    const [visibleLimit, setVisibleLimit] = useState(100);

    const refreshHistory = async () => {
        const [recent, saved] = await Promise.all([
            get<ImportHistoryItem[]>("/imports"),
            get<SavedMapping[]>("/imports/mappings"),
        ]);
        setHistory(recent);
        setSavedMaps(saved);
    };

    useEffect(() => {
        if (!demoMode) {
            refreshHistory().catch(e => setError(e instanceof Error ? e.message : "Riwayat tidak tersedia."));
        }
    }, [demoMode]);

    async function runAction(fn: () => Promise<void>) {
        setBusy(true);
        setError("");
        try {
            await fn();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Operasi gagal.");
        } finally {
            setBusy(false);
        }
    }

    async function resumeBatch(row: ImportHistoryItem) {
        await runAction(async () => {
            const item = await get<{
                id: string;
                status: string;
                config: { sheets: SheetConfig[]; mapping_name?: string };
                result: PreviewResult;
            }>("/imports/" + row.id);
            if (item.status !== "preview") {
                throw new Error("Pratinjau sudah berubah. Muat ulang riwayat.");
            }
            const nextConfigs = item.config.sheets.map(x => ({ ...x, enabled: true, categories: x.categories || {} }));
            setKind(row.kind);
            setConfigs(nextConfigs);
            setMappingName(item.config.mapping_name || "");
            setBatch({
                id: row.id,
                kind: row.kind,
                sheets: nextConfigs.map(x => ({ name: x.name, headers: Object.values(x.mapping), sample: [] })),
            });
            setPreview(item.result);
            setExcluded([]);
            setAccepted([]);
            setDoneMessage("");
            setVisibleLimit(100);
        });
    }

    function applySavedMapping(name: string) {
        const matched = savedMaps.find(x => x.mapping_name === name);
        if (!matched) return;
        setConfigs(prev =>
            prev.map(c => {
                const saved = matched.sheets.find(x => x.name === c.name);
                return saved ? { ...c, ...saved, enabled: true } : c;
            })
        );
        setMappingName(name);
        setPreview(null);
    }

    function updateConfig(index: number, patch: Partial<SheetConfig>) {
        setConfigs(prev => prev.map((item, j) => (j === index ? { ...item, ...patch } : item)));
        setPreview(null);
        setDoneMessage("");
    }

    async function uploadWorkbook() {
        if (!file) return;
        await runAction(async () => {
            const form = new FormData();
            form.append("file", file);
            form.append("kind", kind);
            const uploaded = (await request("/imports/upload", { method: "POST", body: form })) as UploadBatch;
            setBatch(uploaded);
            setConfigs(
                uploaded.sheets.map((s, i) => ({
                    name: s.name,
                    entity:
                        kind === "transactions"
                            ? "transactions"
                            : Object.keys(ENTITY_FIELDS).find(k => k.toLowerCase() === s.name.toLowerCase()) ||
                              "accounts",
                    header_row: 1,
                    mapping: {},
                    date_order: "DMY",
                    default_account: "",
                    enabled: i === 0 || Object.keys(ENTITY_FIELDS).includes(s.name.toLowerCase()),
                }))
            );
            setDoneMessage("");
            setPreview(null);
        });
    }

    async function generatePreview() {
        if (!batch) return;
        await runAction(async () => {
            const result = await post<PreviewResult>("/imports/" + batch.id + "/preview", {
                mapping_name: mappingName.trim() || null,
                sheets: configs.filter(c => c.enabled).map(({ enabled: _e, ...rest }) => rest),
            });
            setPreview(result);
            setExcluded([]);
            setAccepted([]);
            setVisibleLimit(100);
            await refreshHistory();
        });
    }

    async function commitImport() {
        if (!batch || !preview) return;
        await runAction(async () => {
            const toRefs = (keys: string[]) =>
                preview.rows.filter(r => keys.includes(rowKey(r))).map(({ sheet, row }) => ({ sheet, row }));
            const res = await post<{ applied: number; skipped: number }>("/imports/" + batch.id + "/commit", {
                revision: preview.revision,
                exclude: toRefs(excluded),
                accept_similar: toRefs(accepted),
            });
            setDoneMessage(`${res.applied} baris diterapkan · ${res.skipped} dilewati.`);
            setPreview(null);
            setBatch(null);
            setConfigs([]);
            setFile(null);
            await refreshHistory();
            onDone();
        });
    }

    return (
        <div className="stack">
            <div className="card">
                <div className="section-title">
                    <h2>Sumber workbook</h2>
                    <FileSpreadsheet size={20} />
                </div>
                <div className="form">
                    <Field label="Jenis impor">
                        <select
                            value={kind}
                            disabled={busy}
                            onChange={e => {
                                setKind(e.target.value);
                                setBatch(null);
                                setPreview(null);
                                setDoneMessage("");
                            }}
                        >
                            <option value="transactions">Transaksi historis</option>
                            <option value="masters">Master data</option>
                        </select>
                    </Field>

                    {demoMode ? (
                        <div className="info">
                            <a
                                className="text-btn"
                                href={kind === "transactions" ? "/templates/transaksi.xlsx" : "/templates/master.xlsx"}
                                download
                            >
                                <Download size={15} />
                                Unduh template Excel
                            </a>
                            <p>
                                Hubungkan akun untuk memakai workbook milikmu.{" "}
                                <button className="text-btn" onClick={onLogin}>
                                    Hubungkan akun
                                </button>
                            </p>
                        </div>
                    ) : (
                        <>
                            <button
                                className="text-btn"
                                onClick={() =>
                                    runAction(() =>
                                        download("/imports/template?kind=" + kind, `SamSaku_template_${kind}.xlsx`)
                                    )
                                }
                            >
                                <Download size={15} />
                                Unduh template Excel
                            </button>
                            <Field label="Workbook Excel (.xlsx)">
                                <input
                                    type="file"
                                    key={doneMessage}
                                    accept=".xlsx"
                                    onChange={e => {
                                        setFile(e.target.files?.[0] || null);
                                        setBatch(null);
                                        setPreview(null);
                                        setDoneMessage("");
                                    }}
                                />
                            </Field>
                            <button className="btn primary" disabled={!file || busy} onClick={uploadWorkbook}>
                                <Upload size={16} />
                                Baca workbook
                            </button>
                        </>
                    )}
                </div>
            </div>

            {batch && (
                <section className="card form">
                    <h2>Cocokkan kolom</h2>
                    {savedMaps.length > 0 && (
                        <Field label="Gunakan pemetaan tersimpan">
                            <select defaultValue="" onChange={e => applySavedMapping(e.target.value)}>
                                <option value="">Pilih pemetaan</option>
                                {savedMaps.map(m => (
                                    <option key={m.mapping_name}>{m.mapping_name}</option>
                                ))}
                            </select>
                        </Field>
                    )}

                    {configs.map((c, i) => (
                        <div className="mapping" key={c.name}>
                            <label className="check">
                                <input
                                    type="checkbox"
                                    checked={c.enabled}
                                    onChange={e => updateConfig(i, { enabled: e.target.checked })}
                                />
                                {c.name}
                            </label>
                            {c.enabled && (
                                <>
                                    <div className="form-pair">
                                        <Field label="Isi sheet">
                                            <select
                                                value={c.entity}
                                                onChange={e => updateConfig(i, { entity: e.target.value, mapping: {} })}
                                            >
                                                {(kind === "transactions"
                                                    ? ["transactions"]
                                                    : Object.keys(ENTITY_FIELDS).filter(k => k !== "transactions")
                                                ).map(k => (
                                                    <option key={k} value={k}>
                                                        {FIELD_LABELS[k]}
                                                    </option>
                                                ))}
                                            </select>
                                        </Field>
                                        <Field label="Baris judul">
                                            <input
                                                type="number"
                                                min="1"
                                                value={c.header_row}
                                                onChange={e =>
                                                    updateConfig(i, { header_row: Math.max(1, Number(e.target.value)) })
                                                }
                                            />
                                        </Field>
                                    </div>

                                    {c.entity === "transactions" && (
                                        <div className="form-pair">
                                            <Field label="Format tanggal">
                                                <select
                                                    value={c.date_order}
                                                    onChange={e => updateConfig(i, { date_order: e.target.value })}
                                                >
                                                    <option>DMY</option>
                                                    <option>MDY</option>
                                                    <option>YMD</option>
                                                </select>
                                            </Field>
                                            <Field label="Dompet default">
                                                <select
                                                    value={c.default_account}
                                                    onChange={e => updateConfig(i, { default_account: e.target.value })}
                                                >
                                                    <option value="">Dari workbook</option>
                                                    {data.accounts.map(a => (
                                                        <option key={a.id} value={a.code}>
                                                            {a.name}
                                                        </option>
                                                    ))}
                                                </select>
                                            </Field>
                                        </div>
                                    )}

                                    <details>
                                        <summary>
                                            Atur pemetaan kolom <ChevronDown size={14} />
                                        </summary>
                                        <div className="mapping-fields">
                                            {ENTITY_FIELDS[c.entity].map(k => (
                                                <Field key={k} label={FIELD_LABELS[k] || k}>
                                                    <input
                                                        list={`head-${i}`}
                                                        value={c.mapping[k] || ""}
                                                        placeholder="Deteksi otomatis"
                                                        onChange={e => {
                                                            const nextMap = { ...c.mapping };
                                                            if (e.target.value) nextMap[k] = e.target.value;
                                                            else delete nextMap[k];
                                                            updateConfig(i, { mapping: nextMap });
                                                        }}
                                                    />
                                                </Field>
                                            ))}
                                        </div>
                                        <datalist id={`head-${i}`}>
                                            {(
                                                batch.sheets[i].sample[c.header_row - 1]?.map(h => String(h ?? "")) ||
                                                batch.sheets[i].headers
                                            ).map((h, j) => (
                                                <option key={j} value={h} />
                                            ))}
                                        </datalist>
                                    </details>
                                </>
                            )}
                        </div>
                    ))}

                    <Field label="Simpan nama pemetaan (opsional)">
                        <input
                            value={mappingName}
                            maxLength={80}
                            placeholder="Format mutasi BCA saya"
                            onChange={e => {
                                setMappingName(e.target.value);
                                setPreview(null);
                            }}
                        />
                    </Field>
                    <button
                        className="btn primary"
                        disabled={busy || !configs.some(c => c.enabled)}
                        onClick={generatePreview}
                    >
                        Periksa dampak
                    </button>
                </section>
            )}

            {preview && (
                <section className="card form">
                    <h2>Pratinjau impor</h2>
                    {preview.date_start && (
                        <p>
                            {preview.date_start} – {preview.date_end}
                        </p>
                    )}
                    <p>
                        {Object.entries(preview.counts)
                            .map(([k, v]) => `${STATUS_LABELS[k] || k} ${v}`)
                            .join(" · ")}
                    </p>
                    <p>
                        Pemasukan {money(preview.income || 0)} · Pengeluaran {money(preview.expense || 0)}
                    </p>
                    {Object.entries(preview.impacts).map(([code, delta]) => (
                        <p key={code}>
                            Perubahan saldo {code} · {money(delta)}
                        </p>
                    ))}

                    <div className="import-preview">
                        {preview.rows.slice(0, visibleLimit).map(r => {
                            const key = rowKey(r);
                            return (
                                <div className="preview-row" key={key}>
                                    <strong>
                                        {r.sheet} · Baris {r.row}
                                    </strong>
                                    <small>
                                        {STATUS_LABELS[r.status] || r.status} {r.message}
                                    </small>
                                    {Object.entries(r.changes || {}).map(([field, v]) => (
                                        <small key={field}>
                                            {FIELD_LABELS[field] || field} · {v.from} → {v.to}
                                        </small>
                                    ))}
                                    {r.values && (
                                        <small>
                                            {Object.values(r.values)
                                                .filter(v => typeof v === "string" || typeof v === "number")
                                                .slice(0, 6)
                                                .join(" · ")}
                                        </small>
                                    )}
                                    {r.status === "error" &&
                                        r.message.includes("Referensi categories") &&
                                        Boolean(r.values.category) && (
                                            <Field label="Kategori untuk semua baris dengan label ini">
                                                <select
                                                    defaultValue=""
                                                    onChange={e => {
                                                        const idx = configs.findIndex(c => c.name === r.sheet);
                                                        if (idx >= 0) {
                                                            updateConfig(idx, {
                                                                categories: {
                                                                    ...configs[idx].categories,
                                                                    [String(r.values.category)]: e.target.value,
                                                                },
                                                            });
                                                        }
                                                    }}
                                                >
                                                    <option value="">Pilih tindakan</option>
                                                    <option value="__create__">
                                                        Buat kategori {String(r.values.category)}
                                                    </option>
                                                    <option value="__uncategorized__">Belum dikategorikan</option>
                                                    {data.categories.map(c => (
                                                        <option key={c.id} value={c.id}>
                                                            {c.name}
                                                        </option>
                                                    ))}
                                                </select>
                                            </Field>
                                        )}
                                    {needsAttention(r) && (
                                        <label className="check">
                                            <input
                                                type="checkbox"
                                                checked={excluded.includes(key)}
                                                onChange={e =>
                                                    setExcluded(
                                                        e.target.checked
                                                            ? [...excluded, key]
                                                            : excluded.filter(x => x !== key)
                                                    )
                                                }
                                            />
                                            Lewati baris
                                        </label>
                                    )}
                                    {r.status === "similar" && !excluded.includes(key) && (
                                        <label className="check">
                                            <input
                                                type="checkbox"
                                                checked={accepted.includes(key)}
                                                onChange={e =>
                                                    setAccepted(
                                                        e.target.checked
                                                            ? [...accepted, key]
                                                            : accepted.filter(x => x !== key)
                                                    )
                                                }
                                            />
                                            Catat sebagai transaksi terpisah
                                        </label>
                                    )}
                                </div>
                            );
                        })}
                    </div>

                    {preview.rows.length > visibleLimit && (
                        <button className="text-btn" onClick={() => setVisibleLimit(v => v + 100)}>
                            Tampilkan 100 baris berikutnya
                        </button>
                    )}

                    <button
                        className="text-btn"
                        onClick={() =>
                            runAction(() =>
                                download(`/imports/${batch!.id}/errors`, "SamSaku_kesalahan.csv")
                            )
                        }
                    >
                        Unduh daftar kesalahan
                    </button>

                    <button
                        disabled={
                            busy ||
                            preview.rows.some(
                                r => needsAttention(r) && !excluded.includes(rowKey(r)) && !accepted.includes(rowKey(r))
                            )
                        }
                        className="btn primary"
                        onClick={commitImport}
                    >
                        Terapkan{" "}
                        {preview.rows.filter(r => !excluded.includes(rowKey(r)) && r.status !== "duplicate").length}{" "}
                        baris
                    </button>
                </section>
            )}

            {!demoMode && history.length > 0 && !batch && (
                <section className="card">
                    <h2>Riwayat impor</h2>
                    {history.slice(0, 10).map(r => (
                        <div className="preview-row" key={r.id}>
                            <strong>{r.filename}</strong>
                            <small>{STATUS_LABELS[r.status] || r.status}</small>
                            {r.status === "preview" && (
                                <button className="text-btn" onClick={() => resumeBatch(r)} disabled={busy}>
                                    Lanjutkan pratinjau
                                </button>
                            )}
                        </div>
                    ))}
                </section>
            )}

            {doneMessage && (
                <p className="success">
                    <CheckCircle2 size={18} />
                    {doneMessage}
                </p>
            )}
            <ErrorNote message={error} />
            {busy && <p role="status">Memproses workbook…</p>}
        </div>
    );
}
