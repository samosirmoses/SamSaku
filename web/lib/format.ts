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

export function formatSignedDots(val: string | number): string {
    const raw = String(val ?? "").trim();
    if (!raw) return "";
    const neg = raw.startsWith("-");
    const digits = raw.replace(/\D/g, "");
    if (!digits) return neg ? "-" : "";
    return (neg ? "-" : "") + Number(digits).toLocaleString("id-ID");
}

export function parseSignedDigits(val: string): number {
    const raw = val.trim();
    const neg = raw.startsWith("-");
    const digits = raw.replace(/\D/g, "");
    if (!digits) return 0;
    const n = Number(digits);
    return neg && n > 0 ? -n : n;
}

export function generateUUID(): string {
    const c = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
    if (c && typeof c.randomUUID === "function") {
        return c.randomUUID();
    }
    if (c && typeof c.getRandomValues === "function") {
        const bytes = new Uint8Array(16);
        c.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, ch => {
        const r = Math.floor(Math.random() * 16);
        const v = ch === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
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
