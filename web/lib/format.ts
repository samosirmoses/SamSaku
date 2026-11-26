/** Centralized Rupiah, number, and Indonesian date formatting helpers. */

const idrFormatter = new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
});

export function money(v: number): string {
    return idrFormatter.format(v).replace(/\s/g, "");
}

export function compactMoney(v: number): string {
    const abs = Math.abs(v);
    const sign = v < 0 ? "−" : "";
    if (abs >= 1_000_000_000) return sign + "Rp" + (abs / 1_000_000_000).toFixed(1).replace(/\.0$/, "") + "M";
    if (abs >= 1_000_000) return sign + "Rp" + (abs / 1_000_000).toFixed(1).replace(/\.0$/, "") + "jt";
    if (abs >= 1_000) return sign + "Rp" + Math.round(abs / 1_000) + "rb";
    return money(v);
}

export function formatDots(val: string | number): string {
    const digits = String(val).replace(/\D/g, "");
    if (!digits) return "";
    return Number(digits).toLocaleString("id-ID");
}

export function parseDigits(val: string): number {
    const digits = val.replace(/\D/g, "");
    return digits ? Number(digits) : 0;
}

export function shortDate(d: string): string {
    return new Date(d.slice(0, 10) + "T12:00:00").toLocaleDateString("id-ID", {
        day: "numeric",
        month: "short",
    });
}

export function fullDate(d: string): string {
    return new Date(d.slice(0, 10) + "T12:00:00").toLocaleDateString("id-ID", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
    });
}

export function monthLabel(m: string): string {
    return new Date(m + "-01T12:00:00").toLocaleDateString("id-ID", {
        month: "long",
        year: "numeric",
    });
}
