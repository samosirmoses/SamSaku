"use client";
import { type Transaction, expense, period } from "../../lib/domain";

export function SpendingLine({
    rows,
    month,
    startDay,
}: {
    rows: Transaction[];
    month: string;
    startDay: number;
}) {
    const range = period(month, startDay);
    const startMs = new Date(range.start + "T12:00:00").getTime();
    const endMs = new Date(range.end + "T12:00:00").getTime();
    const days = Math.max(1, Math.round((endMs - startMs) / 86400000) + 1);
    const dayTotals = Array(days).fill(0) as number[];
    for (const t of rows) {
        const ms = new Date(t.date.slice(0, 10) + "T12:00:00").getTime();
        const idx = Math.round((ms - startMs) / 86400000);
        if (idx >= 0 && idx < days) dayTotals[idx] += expense(t);
    }
    let sum = 0;
    const cumulative = dayTotals.map(v => (sum += v));
    const max = Math.max(1, ...cumulative);
    const min = Math.min(0, ...cumulative);
    const w = 320;
    const h = 86;
    const points = [0, ...cumulative].map((n, i) => [
        2 + (i / days) * (w - 4),
        h - 8 - ((n - min) / (max - min || 1)) * (h - 16),
    ]);
    const line = points.map(p => p.join(",")).join(" ");
    const last = points[points.length - 1];

    return (
        <div className="spend-graph">
            <div className="graph-label">Kurva pengeluaran kumulatif</div>
            <svg viewBox={"0 0 " + w + " " + h} role="img" aria-label="Tren pengeluaran kumulatif">
                <defs>
                    <linearGradient id="spend-fill" x1="0" x2="0" y1="0" y2="1">
                        <stop offset="0%" stopColor="#e2e8f0" stopOpacity=".22" />
                        <stop offset="100%" stopColor="#e2e8f0" stopOpacity="0" />
                    </linearGradient>
                </defs>
                {[0.2, 0.55, 0.9].map(y => (
                    <line
                        key={y}
                        x1="0"
                        y1={h * y}
                        x2={w}
                        y2={h * y}
                        stroke="#ffffff"
                        strokeOpacity=".12"
                        strokeDasharray="3 5"
                    />
                ))}
                <polygon points={"2," + h + " " + line + " " + (w - 2) + "," + h} fill="url(#spend-fill)" />
                <polyline
                    points={line}
                    fill="none"
                    stroke="#e2e8f0"
                    strokeWidth="2.2"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                />
                <circle cx={last[0]} cy={last[1]} r="3.5" fill="#ffffff" />
            </svg>
            <div className="graph-labels">
                <span>Tgl {Number(range.start.slice(8))}</span>
                <span>Tgl {Number(range.end.slice(8))}</span>
            </div>
        </div>
    );
}
