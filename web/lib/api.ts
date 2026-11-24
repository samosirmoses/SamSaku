import { createClient, type SupabaseClient } from "@supabase/supabase-js";
export const endpoint = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000/v1").replace(/\/$/, "");
let sb: SupabaseClient | null = null;
export function supabase() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (url && key && !sb)
        sb = createClient(url, key, { auth: { flowType: "pkce" } });
    return sb;
}
export const isLoopback = (s: string) => ["127.0.0.1", "localhost", "[::1]"].includes(s);
export function allowDev() { return typeof window !== "undefined" && isLoopback(location.hostname) && isLoopback(new URL(endpoint, location.href).hostname); }
export async function request(path: string, init: RequestInit = {}, asBlob = false): Promise<unknown> {
    const headers = new Headers(init.headers);
    if (init.body && typeof init.body === "string")
        headers.set("Content-Type", "application/json");
    const token = (await supabase()?.auth.getSession())?.data.session?.access_token;
    if (token)
        headers.set("Authorization", "Bearer " + token);
    else if (allowDev()) {
        const key = sessionStorage.getItem("samsaku-dev");
        if (key)
            headers.set("X-Dev-Token", key);
    }
    let res: Response;
    try {
        res = await fetch(endpoint + path, { ...init, headers, cache: "no-store" });
    }
    catch {
        throw new Error("API tidak terjangkau. Periksa koneksi dan alamat server SamSaku.");
    }
    if (!res.ok) {
        let msg = res.statusText;
        try {
            const body = await res.json();
            msg = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail || body.error || body);
        }
        catch { }
        throw new Error("Permintaan gagal (" + res.status + "). " + msg);
    }
    if (asBlob)
        return res.blob();
    return res.status === 204 ? null : res.json();
}
export const get = <T,>(path: string) => request(path) as Promise<T>;
export const post = <T,>(path: string, body: unknown) => request(path, { method: "POST", body: JSON.stringify(body) }) as Promise<T>;
export async function download(path: string, filename: string) { const blob = await request(path, {}, true) as Blob; saveBlob(blob, filename); }
export function saveBlob(blob: Blob, name: string) { const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
