"use client";
import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { partitionDonutItems } from "../../lib/charts";
import { compactMoney, money } from "../../lib/domain";

const PALETTE = ["#334155", "#2563eb", "#d97706", "#7c3aed", "#0284c7", "#64748b", "#4f46e5", "#94a3b8"];

export function DonutChart({
    items,
    total,
    kind,
    onSelectCategory,
}: {
    items: { name: string; amount: number }[];
    total: number;
    kind: "expense" | "income";
    onSelectCategory?: (name: string) => void;
}) {
    const [activeIdx, setActiveIdx] = useState<number | null>(null);
    const { positive, credits, positiveTotal } = partitionDonutItems(items);

    if (!positive.length && !credits.length) {
        return (
            <p className="empty">
                Belum ada data {kind === "expense" ? "pengeluaran" : "pemasukan"} pada siklus ini.
            </p>
        );
    }
    const r = 68;
    const c = 2 * Math.PI * r;
    let offset = 0;
    const focused = activeIdx !== null && positive[activeIdx] ? positive[activeIdx] : null;
    const safeDenom = positiveTotal > 0 ? positiveTotal : 1;

    return (
        <div className="donut-layout">
            <div className="donut-svg-wrap">
                <svg viewBox="0 0 180 180" className="donut-svg" role="img" aria-label="Distribusi kategori">
                    <circle cx="90" cy="90" r={r} fill="none" stroke="var(--track-bg)" strokeWidth="24" />
                    {positiveTotal > 0 &&
                        positive.map((item, i) => {
                            const ratio = item.amount / safeDenom;
                            const dash = ratio * c;
                            const currentOffset = offset;
                            offset += dash;
                            const isHovered = activeIdx === i;
                            return (
                                <circle
                                    key={item.name}
                                    cx="90"
                                    cy="90"
                                    r={r}
                                    fill="none"
                                    stroke={PALETTE[i % PALETTE.length]}
                                    strokeWidth={isHovered ? "28" : "23"}
                                    strokeDasharray={`${Math.max(1, dash)} ${c}`}
                                    strokeDashoffset={-currentOffset}
                                    transform="rotate(-90 90 90)"
                                    style={{ cursor: "pointer", transition: "stroke-width .15s ease" }}
                                    onMouseEnter={() => setActiveIdx(i)}
                                    onMouseLeave={() => setActiveIdx(null)}
                                    onClick={() => onSelectCategory?.(item.name)}
                                />
                            );
                        })}
                    <text x="90" y="82" textAnchor="middle" className="donut-center-label">
                        {focused ? focused.name.slice(0, 14) : "Total"}
                    </text>
                    <text x="90" y="102" textAnchor="middle" className="donut-center-value">
                        {compactMoney(focused ? focused.amount : total)}
                    </text>
                    {focused && (
                        <text x="90" y="118" textAnchor="middle" className="donut-center-label">
                            {Math.round((100 * focused.amount) / safeDenom)}%
                        </text>
                    )}
                </svg>
            </div>
            <div className="donut-legend">
                {positive.map((item, i) => {
                    const pct = Math.round((100 * item.amount) / safeDenom);
                    const color = PALETTE[i % PALETTE.length];
                    return (
                        <button
                            type="button"
                            key={item.name}
                            className={"donut-legend-row " + (activeIdx === i ? "active" : "")}
                            onMouseEnter={() => setActiveIdx(i)}
                            onMouseLeave={() => setActiveIdx(null)}
                            onClick={() => onSelectCategory?.(item.name)}
                            title={`Klik untuk lihat transaksi ${item.name}`}
                        >
                            <div className="donut-row-top">
                                <span className="donut-name-wrap">
                                    <span className="donut-swatch" style={{ backgroundColor: color }} />
                                    <span className="donut-legend-name">{item.name}</span>
                                </span>
                                <span className="donut-amount-wrap">
                                    <span className="donut-pct-badge">{pct}%</span>
                                    <strong>{money(item.amount)}</strong>
                                    {onSelectCategory && <ArrowRight size={13} className="muted" />}
                                </span>
                            </div>
                            <span className="bar-track" style={{ height: 5, width: "100%" }}>
                                <span
                                    className="bar"
                                    style={{
                                        width: Math.max(2, pct) + "%",
                                        backgroundColor: color,
                                    }}
                                />
                            </span>
                        </button>
                    );
                })}
                {credits.map(item => (
                    <button
                        type="button"
                        key={item.name}
                        className="donut-legend-row"
                        onClick={() => onSelectCategory?.(item.name)}
                        title={`Refund bersih pada ${item.name}`}
                    >
                        <div className="donut-row-top">
                            <span className="donut-name-wrap">
                                <span className="donut-swatch" style={{ backgroundColor: "var(--income, #16a34a)" }} />
                                <span className="donut-legend-name">{item.name} (Refund)</span>
                            </span>
                            <span className="donut-amount-wrap">
                                <strong className="income">+{money(Math.abs(item.amount))}</strong>
                                {onSelectCategory && <ArrowRight size={13} className="muted" />}
                            </span>
                        </div>
                    </button>
                ))}
            </div>
        </div>
    );
}
