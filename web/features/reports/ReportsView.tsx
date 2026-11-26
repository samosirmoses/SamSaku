"use client";
import { useEffect, useState } from "react";
import { ArrowDownToLine, Download, FileText } from "lucide-react";
import { ErrorNote, Field } from "../../components/ui";
import { download, get, saveBlob } from "../../lib/api";
import { type Data, type Summary, kindLabels, money, period, shortDate } from "../../lib/domain";

export function ReportsView({
    data,
    month,
    demoMode,
    setMonth,
}: {
    data: Data;
    month: string;
    demoMode: boolean;
    setMonth: (v: string) => void;
}) {
    const [details, setDetails] = useState(true);
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
    const startDay = data.settings?.monthly_start_day || 1;
    const monthly = {
        start: data.summary?.start || period(month, startDay).start,
        end: data.summary?.end || period(month, startDay).end,
    };
    const [custom, setCustom] = useState(false);
    const [range, setRange] = useState(() => period(month, startDay));
    const [snapshot, setSnapshot] = useState<Summary | null>(null);
    const [pending, setPending] = useState(false);

    useEffect(() => {
        if (!custom) {
            setRange({
                start: data.summary?.start || period(month, startDay).start,
                end: data.summary?.end || period(month, startDay).end,
            });
        }
    }, [month, startDay, data.summary?.start, data.summary?.end, custom]);

    const { start, end } = custom ? range : monthly;
    const invalid = !start || !end || start > end;
    const summary = custom ? snapshot : data.summary;

    useEffect(() => {
        if (!custom) return;
        let active = true;
        setSnapshot(null);
        setError("");
        if (invalid) {
            setPending(false);
            return;
        }
        setPending(true);
        get<Summary>("/summary?" + new URLSearchParams({ start, end }))
            .then(result => {
                if (active) setSnapshot(result);
            })
            .catch(e => {
                if (active) setError(e.message);
            })
            .finally(() => {
                if (active) setPending(false);
            });
        return () => {
            active = false;
        };
    }, [custom, start, end, invalid]);

    async function run(format: "pdf" | "csv") {
        setBusy(format);
        setError("");
        try {
            if (demoMode) {
                if (format === "pdf") {
                    window.print();
                } else {
                    const lines = [
                        ["Tanggal", "Jenis", "Dompet", "Keterangan", "Kategori", "Nominal (IDR)"],
                        ...(summary?.transactions || []).map(t => [
                            t.date,
                            kindLabels[t.kind],
                            t.account_name || "",
                            t.description || "",
                            t.category_name || "",
                            t.amount,
                        ]),
                    ];
                    saveBlob(
                        new Blob(
                            [
                                "\uFEFF" +
                                    lines
                                        .map(row =>
                                            row.map(v => '"' + String(v).replaceAll('"', '""') + '"').join(",")
                                        )
                                        .join("\r\n"),
                            ],
                            { type: "text/csv;charset=utf-8" }
                        ),
                        `SamSaku_${start}_${end}.csv`
                    );
                }
            } else {
                await download(
                    "/reports/" + format + "?" + new URLSearchParams({ start, end, details: String(details) }),
                    "SamSaku_" + start + "_" + end + "." + format
                );
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : "Gagal membuat laporan.");
        } finally {
            setBusy("");
        }
    }

    return (
        <div className="report-layout">
            {summary ? (
                <div className="report-paper">
                    <div className="paper-top">
                        <span>SamSaku</span>
                        <FileText size={20} />
                    </div>
                    <h2>Laporan keuangan</h2>
                    <p>
                        {shortDate(start)} –{" "}
                        {new Date(end + "T12:00:00").toLocaleDateString("id-ID", {
                            day: "numeric",
                            month: "long",
                            year: "numeric",
                        })}
                        {demoMode ? " · Sandbox Interaktif" : ""}
                    </p>
                    <div className="paper-totals">
                        {[
                            ["Pemasukan", summary.income],
                            ["Pengeluaran", summary.expense],
                            ["Arus kas bersih", summary.net],
                        ].map(([k, v]) => (
                            <div key={k}>
                                <span>{k}</span>
                                <b>{money(Number(v))}</b>
                            </div>
                        ))}
                    </div>

                    {summary.partial_history && (
                        <p>Riwayat sebagian · Ada transaksi sebelum tanggal saldo awal.</p>
                    )}

                    {summary.reviews > 0 && <p>{summary.reviews} bukti menunggu tinjauan</p>}
                    <h3>Rincian kategori pengeluaran</h3>

                    {summary.categories.length ? (
                        summary.categories.map(c => (
                            <div className="paper-line" key={c.name}>
                                <span>{c.name}</span>
                                <strong>{money(c.amount)}</strong>
                            </div>
                        ))
                    ) : (
                        <p className="empty">Belum ada pengeluaran pada periode ini.</p>
                    )}

                    {details && (
                        <>
                            <h3>Rincian transaksi</h3>
                            {summary.transactions.length ? (
                                summary.transactions.map(t => (
                                    <div className="paper-line" key={t.id}>
                                        <span>
                                            <small>
                                                {shortDate(t.date)} · {kindLabels[t.kind]} · {t.account_name}
                                                {t.category_name ? ` · ${t.category_name}` : ""}
                                            </small>
                                            {t.description || t.category_name || kindLabels[t.kind]}
                                        </span>
                                        <strong>{money(t.amount)}</strong>
                                    </div>
                                ))
                            ) : (
                                <p className="empty">Belum ada transaksi pada periode ini.</p>
                            )}
                        </>
                    )}
                </div>
            ) : (
                <div className="card" role="status">
                    {invalid
                        ? "Periksa tanggal mulai dan akhir laporan."
                        : pending
                          ? "Memuat pratinjau…"
                          : "Pratinjau belum tersedia."}
                </div>
            )}
            <div className="card form report-settings">
                <h2>Ekspor laporan</h2>

                <Field label="Periode">
                    <select
                        value={custom ? "custom" : "month"}
                        onChange={e => {
                            setRange(monthly);
                            setCustom(e.target.value === "custom");
                        }}
                    >
                        <option value="month">
                            Siklus bulanan ({shortDate(monthly.start)} – {shortDate(monthly.end)})
                        </option>
                        <option value="custom">Pilih rentang tanggal</option>
                    </select>
                </Field>

                {custom ? (
                    <>
                        <Field label="Tanggal mulai">
                            <input
                                type="date"
                                value={start}
                                onChange={e => setRange({ ...range, start: e.target.value })}
                            />
                        </Field>
                        <Field label="Tanggal akhir">
                            <input
                                type="date"
                                value={end}
                                onChange={e => setRange({ ...range, end: e.target.value })}
                            />
                        </Field>
                    </>
                ) : (
                    <Field label="Bulan laporan">
                        <input type="month" value={month} onChange={e => e.target.value && setMonth(e.target.value)} />
                    </Field>
                )}
                <label className="check">
                    <input type="checkbox" checked={details} onChange={e => setDetails(e.target.checked)} />
                    Sertakan rincian transaksi di PDF
                </label>
                <button className="btn primary" disabled={!!busy || !summary || invalid} onClick={() => run("pdf")}>
                    <Download size={16} />
                    {busy === "pdf" ? "Menyiapkan…" : demoMode ? "Cetak / simpan PDF" : "Unduh PDF"}
                </button>
                <button className="btn" disabled={!!busy || !summary || invalid} onClick={() => run("csv")}>
                    <ArrowDownToLine size={16} />
                    {busy === "csv" ? "Menyiapkan…" : "Ekspor CSV"}
                </button>
                <ErrorNote message={error} />
            </div>
        </div>
    );
}
