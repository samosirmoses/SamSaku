"use client";
import { useState, type FormEvent } from "react";
import { Calendar, CheckCircle2, Moon, RotateCcw, Settings as SettingsIcon, Sun, Wallet } from "lucide-react";
import { put } from "../lib/api";
import { resetDemoStore } from "../lib/demo";
import { type Data, type Settings, cycleMonthForDate, monthLabel, periodRangeLabel, today, weekdayNames } from "../lib/domain";
import { ErrorNote, Field } from "./ui";

export function SettingsView({
    data,
    month,
    demoMode,
    theme,
    onToggleTheme,
    onDone,
}: {
    data: Data;
    month: string;
    demoMode: boolean;
    theme: "light" | "dark";
    onToggleTheme: (t: "light" | "dark") => void;
    onDone: (nextStartDay?: number) => void;
}) {
    const [monthlyStartDay, setMonthlyStartDay] = useState<number>(data.settings?.monthly_start_day || 1);
    const [weeklyStartDay, setWeeklyStartDay] = useState<number>(data.settings?.weekly_start_day ?? 1);
    const [defaultAccountId, setDefaultAccountId] = useState<string>(data.settings?.default_account_id || "");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [saved, setSaved] = useState(false);

    async function submit(e: FormEvent<HTMLFormElement>) {
        e.preventDefault();
        setBusy(true);
        setError("");
        setSaved(false);
        const payload: Settings = {
            monthly_start_day: Math.max(1, Math.min(31, Number(monthlyStartDay) || 1)),
            weekly_start_day: Number(weeklyStartDay),
            default_account_id: defaultAccountId || null,
        };
        try {
            await put("/settings", payload);
            setSaved(true);
            onDone(payload.monthly_start_day);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Gagal menyimpan pengaturan.");
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="two-cols">
            <section className="card">
                <div className="section-title">
                    <h2>Preferensi Siklus, Tema & Dompet</h2>
                    <SettingsIcon size={18} />
                </div>
                <form className="form" onSubmit={submit}>
                    <div className="field">
                        <span>Tema Tampilan Aplikasi</span>
                        <div className="selector-grid two">
                            <button
                                type="button"
                                className={"selector-card " + (theme === "light" ? "active" : "")}
                                onClick={() => onToggleTheme("light")}
                            >
                                <Sun size={18} />
                                <strong>Mode Terang (Light)</strong>
                            </button>
                            <button
                                type="button"
                                className={"selector-card " + (theme === "dark" ? "active" : "")}
                                onClick={() => onToggleTheme("dark")}
                            >
                                <Moon size={18} />
                                <strong>Mode Gelap (Dark)</strong>
                            </button>
                        </div>
                    </div>

                    <Field label="Tanggal mulai siklus bulanan (Monthly Start Date)">
                        <select
                            value={monthlyStartDay}
                            onChange={e => {
                                setMonthlyStartDay(Number(e.target.value));
                                setSaved(false);
                            }}
                        >
                            {Array.from({ length: 31 }, (_, i) => i + 1).map(day => (
                                <option key={day} value={day}>
                                    Tanggal {day} setiap bulan{" "}
                                    {day === 1 ? "(Default kalender)" : day === 25 ? "(Siklus gajian)" : ""}
                                </option>
                            ))}
                        </select>
                    </Field>
                    <p className="muted" style={{ fontSize: 12 }}>
                        Pratinjau periode <b>{monthLabel(cycleMonthForDate(today(), monthlyStartDay))}</b>:{" "}
                        <b>{periodRangeLabel(cycleMonthForDate(today(), monthlyStartDay), monthlyStartDay)}</b>.
                        {monthlyStartDay >= 15
                            ? " (Karena mulai tgl >= 15, periode dinamai mengikuti bulan berakhirnya agar sesuai siklus gajian.)"
                            : " Seluruh perhitungan Dashboard, Transaksi, Anggaran, dan Statistik mengikuti rentang ini."}
                    </p>

                    <Field label="Hari pertama mingguan (Weekly Start Date)">
                        <select
                            value={weeklyStartDay}
                            onChange={e => {
                                setWeeklyStartDay(Number(e.target.value));
                                setSaved(false);
                            }}
                        >
                            {[1, 0, 6, 5, 4, 3, 2].map(d => (
                                <option key={d} value={d}>
                                    {weekdayNames[d]} {d === 1 ? "(Default)" : ""}
                                </option>
                            ))}
                        </select>
                    </Field>

                    <Field label="Dompet utama (default saat input transaksi & foto struk)">
                        <select
                            value={defaultAccountId}
                            onChange={e => {
                                setDefaultAccountId(e.target.value);
                                setSaved(false);
                            }}
                        >
                            <option value="">Dompet pertama di daftar</option>
                            {data.accounts.map(a => (
                                <option key={a.id} value={a.id}>
                                    {a.name}
                                </option>
                            ))}
                        </select>
                    </Field>

                    {saved && (
                        <div className="success">
                            <CheckCircle2 size={17} />
                            <span>Pengaturan berhasil disimpan dan diterapkan.</span>
                        </div>
                    )}
                    <ErrorNote message={error} />
                    <button type="submit" className="btn primary" disabled={busy}>
                        {busy ? "Menyimpan…" : "Simpan pengaturan"}
                    </button>
                </form>
            </section>

            <div className="stack">
                <section className="card">
                    <div className="section-title">
                        <h2>Ringkasan konfigurasi aktif</h2>
                        <Calendar size={18} />
                    </div>
                    <div className="paper-line">
                        <span>Tema antarmuka</span>
                        <b>{theme === "dark" ? "Mode Gelap (Dark)" : "Mode Terang (Light)"}</b>
                    </div>
                    <div className="paper-line">
                        <span>Awal siklus bulanan</span>
                        <b>Tanggal {monthlyStartDay}</b>
                    </div>
                    <div className="paper-line">
                        <span>Rentang periode aktif</span>
                        <b>{periodRangeLabel(cycleMonthForDate(today(), monthlyStartDay), monthlyStartDay)}</b>
                    </div>
                    <div className="paper-line">
                        <span>Awal pekan kalender</span>
                        <b>{weekdayNames[weeklyStartDay]}</b>
                    </div>
                    <div className="paper-line">
                        <span>Dompet utama</span>
                        <b>
                            {data.accounts.find(a => a.id === defaultAccountId)?.name ||
                                data.accounts[0]?.name ||
                                "Belum diatur"}
                        </b>
                    </div>
                </section>

                {demoMode && (
                    <section className="card">
                        <div className="section-title">
                            <h2>Data contoh interaktif</h2>
                            <RotateCcw size={18} />
                        </div>
                        <p className="muted" style={{ marginBottom: 12 }}>
                            Anda sedang berada di mode sandbox interaktif. Semua penambahan/perubahan dompet, transaksi,
                            dan anggaran disimpan di browser Anda.
                        </p>
                        <button
                            type="button"
                            className="btn"
                            onClick={() => {
                                resetDemoStore();
                                onDone();
                            }}
                        >
                            <RotateCcw size={15} /> Reset data contoh ke awal
                        </button>
                    </section>
                )}

                {data.connections && (
                    <section className="card">
                        <div className="section-title">
                            <h2>Status konektor otomatis</h2>
                            <Wallet size={18} />
                        </div>
                        {data.connections.map(c => (
                            <div key={c.source} className="paper-line">
                                <span>{c.source.toUpperCase()}</span>
                                <small>
                                    {c.last_received_at
                                        ? new Date(c.last_received_at).toLocaleString("id-ID", {
                                              timeZone: "Asia/Jakarta",
                                          })
                                        : "Belum ada aktivitas"}
                                </small>
                            </div>
                        ))}
                    </section>
                )}
            </div>
        </div>
    );
}
