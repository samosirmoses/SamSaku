"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { get } from "../lib/api";
import { type Data, cycleMonthForDate, today } from "../lib/domain";

export function useLedgerData({ ready, demoMode }: { ready: boolean; demoMode: boolean }) {
    const [month, setMonthState] = useState("");
    const [data, setData] = useState<Data | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [refreshTick, setRefreshTick] = useState(0);

    const loadedMonth = useRef("");
    const userPickedMonth = useRef(false);
    const silentRefresh = useRef(false);
    const lastFetchedAt = useRef(0);

    useEffect(() => {
        setMonthState(today().slice(0, 7));
    }, []);

    const pickMonth = useCallback((nextMonth: string, manual = true) => {
        userPickedMonth.current = manual;
        setMonthState(nextMonth);
    }, []);

    const refresh = useCallback((silent = false) => {
        silentRefresh.current = silent;
        setRefreshTick(v => v + 1);
    }, []);

    useEffect(() => {
        if (!month || !ready) return;
        let valid = true;
        const isSilent = silentRefresh.current && loadedMonth.current === month;
        silentRefresh.current = false;
        setError("");
        if (!isSilent) {
            if (loadedMonth.current !== month) setData(null);
            setLoading(true);
        }

        // Single consolidated request replaces the 7-request waterfall
        const query = userPickedMonth.current ? `?month=${encodeURIComponent(month)}` : "";
        get<Data>("/bootstrap" + query)
            .then(res => {
                if (!valid || !res) return;
                const startDay = res.settings?.monthly_start_day || 1;
                const resolvedMonth = res.month || cycleMonthForDate(today(), startDay);
                if (!userPickedMonth.current && resolvedMonth !== month) {
                    setMonthState(resolvedMonth);
                }
                loadedMonth.current = resolvedMonth;
                lastFetchedAt.current = Date.now();
                setData({
                    ...res,
                    transactions: res.summary?.transactions || res.transactions || [],
                    budgets: res.summary?.budgets || res.budgets || [],
                });
            })
            .catch(e => {
                if (valid && !isSilent) setError(e instanceof Error ? e.message : "Gagal memuat data.");
            })
            .finally(() => {
                if (valid && !isSilent) setLoading(false);
            });

        return () => {
            valid = false;
        };
    }, [month, ready, demoMode, refreshTick]);

    return {
        month,
        pickMonth,
        data,
        loading,
        error,
        setError,
        refresh,
        lastFetchedAt,
    };
}
