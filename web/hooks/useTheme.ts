"use client";
import { useCallback, useEffect, useState } from "react";

export type ThemeMode = "light" | "dark";

export function useTheme() {
    const [theme, setTheme] = useState<ThemeMode>("light");

    const applyTheme = useCallback((next: ThemeMode) => {
        setTheme(next);
        if (typeof document !== "undefined") {
            document.documentElement.setAttribute("data-theme", next);
            try {
                localStorage.setItem("samsaku-theme", next);
            } catch {}
        }
    }, []);

    useEffect(() => {
        try {
            const saved = localStorage.getItem("samsaku-theme");
            if (saved === "dark" || saved === "light") {
                applyTheme(saved);
            }
        } catch {}
    }, [applyTheme]);

    return { theme, applyTheme };
}
