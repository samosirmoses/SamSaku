"use client";
import { useCallback, useEffect, useState } from "react";
import { allowDev, getSavedToken, setSavedToken, supabase } from "../lib/api";

export function useAuth() {
    const [authed, setAuthed] = useState(false);
    const [demoMode, setDemoMode] = useState(true);
    const [ready, setReady] = useState(false);

    useEffect(() => {
        const sb = supabase();
        let alive = true;
        const listen = sb?.auth.onAuthStateChange((_ev, session) => {
            if (alive) {
                const ok = !!session || (allowDev() && !!getSavedToken());
                setAuthed(ok);
                setDemoMode(!ok);
                setReady(true);
            }
        });
        if (!sb) {
            const ok = allowDev() && !!getSavedToken();
            setAuthed(ok);
            setDemoMode(!ok);
            setReady(true);
        }
        if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
            navigator.serviceWorker.register("/sw.js").catch(() => {});
        }
        return () => {
            alive = false;
            listen?.data.subscription.unsubscribe();
        };
    }, []);

    const markConnected = useCallback(() => {
        setAuthed(true);
        setDemoMode(false);
    }, []);

    const logout = useCallback(async (): Promise<string | null> => {
        const { error } = (await supabase()?.auth.signOut()) || {};
        if (error) return error.message;
        setSavedToken("");
        setAuthed(false);
        setDemoMode(true);
        return null;
    }, []);

    return { authed, demoMode, ready, markConnected, logout };
}
