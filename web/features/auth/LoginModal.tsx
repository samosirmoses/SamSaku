"use client";
import { useState, type FormEvent } from "react";
import { LogIn } from "lucide-react";
import { ErrorNote, Field } from "../../components/ui";
import { allowDev, get, setSavedToken, supabase } from "../../lib/api";

export function LoginModal({
    authed,
    onLogout,
    onConnected,
}: {
    authed: boolean;
    onLogout: () => void;
    onConnected: () => void;
}) {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [key, setKey] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    async function emailLogin(e: FormEvent) {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
            const sb = supabase();
            if (!sb) throw new Error("Koneksi Supabase belum dikonfigurasi.");
            const { error: authErr } = await sb.auth.signInWithPassword({
                email: email.trim(),
                password,
            });
            if (authErr) throw authErr;
            onConnected();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Email atau password tidak sesuai.");
        } finally {
            setBusy(false);
        }
    }

    async function googleLogin() {
        setBusy(true);
        setError("");
        try {
            const sb = supabase();
            if (!sb) throw new Error("Login Google belum dikonfigurasi pada aplikasi ini.");
            const { error: authErr } = await sb.auth.signInWithOAuth({
                provider: "google",
                options: { redirectTo: location.origin + "/" },
            });
            if (authErr) throw authErr;
        } catch (e) {
            setError(e instanceof Error ? e.message : "Login gagal.");
            setBusy(false);
        }
    }

    async function tokenLogin() {
        setError("");
        setBusy(true);
        try {
            setSavedToken(key.trim());
            await get("/accounts");
            onConnected();
        } catch (e) {
            setSavedToken("");
            setError(e instanceof Error ? e.message : "Password/Token akses tidak sesuai.");
        } finally {
            setBusy(false);
        }
    }

    if (authed) {
        return (
            <div className="form">
                <p className="muted">Terhubung ke database PostgreSQL SamSaku.</p>
                <button className="btn" onClick={onLogout}>
                    Keluar ke Sandbox Interaktif
                </button>
            </div>
        );
    }

    return (
        <div className="form">
            <p className="muted">Masuk ke akun pemilik untuk menyinkronkan data dengan database PostgreSQL.</p>
            {supabase() && (
                <>
                    <form className="form" onSubmit={emailLogin}>
                        <Field label="Email pemilik">
                            <input
                                type="email"
                                required
                                value={email}
                                onChange={e => setEmail(e.target.value)}
                                placeholder="nama@email.com"
                            />
                        </Field>
                        <Field label="Password">
                            <input
                                type="password"
                                required
                                value={password}
                                onChange={e => setPassword(e.target.value)}
                                placeholder="••••••••"
                            />
                        </Field>
                        <button type="submit" disabled={busy || !email || !password} className="btn primary">
                            <LogIn size={16} /> Masuk dengan Email
                        </button>
                    </form>
                    <button type="button" disabled={busy} className="btn" onClick={googleLogin}>
                        <LogIn size={16} /> Masuk dengan Google (Opsional)
                    </button>
                </>
            )}
            {allowDev() && (
                <>
                    <Field label="Password / Token Akses Server (SAMSAKU_DEV_TOKEN)">
                        <input
                            type="password"
                            value={key}
                            autoComplete="off"
                            onChange={e => setKey(e.target.value)}
                            placeholder="Masukkan password/token akses Anda"
                        />
                    </Field>
                    <button disabled={busy || !key} className="btn primary" onClick={tokenLogin}>
                        Hubungkan Server SamSaku
                    </button>
                </>
            )}
            {!supabase() && !allowDev() && <p>Login belum dikonfigurasi. Atur koneksi Supabase pada deployment.</p>}
            <ErrorNote message={error} />
        </div>
    );
}
