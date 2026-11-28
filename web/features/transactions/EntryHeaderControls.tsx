"use client";
import type { ChangeEvent, RefObject } from "react";
import {
    ArrowDownLeft,
    ArrowLeftRight,
    ArrowUpRight,
    Camera,
    CheckCircle2,
    RotateCcw,
    Sparkles,
    X,
} from "lucide-react";
import { type Category, type Transaction, kindLabels, shortDate } from "../../lib/domain";

export function EntryHeaderControls({
    isEdit,
    autoScan,
    kind,
    txDate,
    todayIso,
    yesterdayIso,
    busy,
    scanning,
    scanInfo,
    savedFlash,
    receiptPreviewUrl,
    fileInputRef,
    categories,
    catId,
    onKindChange,
    onClearOriginalId,
    onResetCategoryIfInvalid,
    onDateChange,
    onReceiptFile,
}: {
    isEdit: boolean;
    autoScan: boolean;
    kind: Transaction["kind"];
    txDate: string;
    todayIso: string;
    yesterdayIso: string;
    busy: boolean;
    scanning: boolean;
    scanInfo: string;
    savedFlash: string;
    receiptPreviewUrl: string;
    fileInputRef: RefObject<HTMLInputElement | null>;
    categories: Category[];
    catId: string;
    onKindChange: (next: Transaction["kind"]) => void;
    onClearOriginalId: () => void;
    onResetCategoryIfInvalid: () => void;
    onDateChange: (iso: string) => void;
    onReceiptFile: (e: ChangeEvent<HTMLInputElement>) => void;
}) {
    return (
        <>
            {kind === "refund" ? (
                <div className="refund-mode-banner">
                    <span>
                        <RotateCcw size={15} /> Mode <b>Refund Pengeluaran</b>
                    </span>
                    {!isEdit && (
                        <button
                            type="button"
                            className="btn sm"
                            onClick={() => {
                                onKindChange("expense");
                                onClearOriginalId();
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
                                    onKindChange(k);
                                    const validCat = categories.find(
                                        c => c.id === catId && c.kind === (k === "income" ? "income" : "expense")
                                    );
                                    if (!validCat) onResetCategoryIfInvalid();
                                }}
                            >
                                <Icon size={15} />
                                <span>{kindLabels[k]}</span>
                            </button>
                        );
                    })}
                </div>
            )}

            <div className="entry-meta-strip">
                <div className="quick-date-group">
                    <button
                        type="button"
                        className={"date-chip " + (txDate === todayIso ? "active" : "")}
                        onClick={() => onDateChange(todayIso)}
                    >
                        Hari ini
                    </button>
                    <button
                        type="button"
                        className={"date-chip " + (txDate === yesterdayIso ? "active" : "")}
                        onClick={() => onDateChange(yesterdayIso)}
                    >
                        Kemarin
                    </button>
                    <label
                        className={
                            "date-chip picker " + (txDate !== todayIso && txDate !== yesterdayIso ? "active" : "")
                        }
                    >
                        <span>{txDate !== todayIso && txDate !== yesterdayIso ? shortDate(txDate) : "Pilih tgl"}</span>
                        <input
                            type="date"
                            name="date"
                            aria-label="Tanggal transaksi"
                            value={txDate}
                            onChange={e => e.target.value && onDateChange(e.target.value)}
                            required
                        />
                    </label>
                </div>
                {!isEdit && !autoScan && (
                    <label className="btn sm scan-compact-btn">
                        <Camera size={14} />
                        <span>{scanning ? "Membaca…" : receiptPreviewUrl ? "Ganti Struk" : "Scan Struk"}</span>
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="image/png,image/jpeg,image/webp"
                            disabled={scanning || busy}
                            onChange={onReceiptFile}
                        />
                    </label>
                )}
            </div>

            {!isEdit && (autoScan || receiptPreviewUrl || scanning) && (
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
                            onChange={onReceiptFile}
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
        </>
    );
}
