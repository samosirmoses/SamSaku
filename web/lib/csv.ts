export function safeCsvCell(value: unknown): string {
    if (value == null) return "";
    const text = String(value);
    if (/^[=+\-@\t\r]/.test(text) || /^[=+\-@]/.test(text.trimStart())) {
        return "'" + text;
    }
    return text;
}

export function formatCsvCell(value: unknown): string {
    const safe = safeCsvCell(value);
    return '"' + safe.replaceAll('"', '""') + '"';
}

export function buildCsvRows(headers: string[], rows: unknown[][]): string {
    return (
        "\uFEFF" +
        [headers, ...rows].map(row => row.map(formatCsvCell).join(",")).join("\r\n")
    );
}
