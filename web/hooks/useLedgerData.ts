"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { get } from "../lib/api";
import { type Data, cycleMonthForDate, today } from "../lib/domain";

const EMPTY_SET = new Set<string>();

export function useLedgerData({ ready, demoMode }: { ready: boolean; demoMode: boolean }) {
    const [month, setMonthState] = useState("");
    const [data, setData] = useState<Data | null>(null);
    const [loading, setLoading] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState("");
    const [refreshTick, setRefreshTick] = useState(0);
    const [recentIds, setRecentIds] = useState<Set<string>>(EMPTY_SET);

    const loadedMonth = useRef("");
    const userPickedMonth = useRef(false);
    const silentRefresh = useRef(false);
    const lastFetchedAt = useRef(0);
    const requestSeq = useRef(0);
    const prevSnapshotIds = useRef<Set<string> | null>(null);
    const prevModeRef = useRef<boolean | null>(null);
    const pulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        setMonthState(today().slice(0, 7));
        return () => {
            if (pulseTimer.current) clearTimeout(pulseTimer.current);
        };
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

        // Reset snapshot tracking when switching between Sandbox and Authenticated Server
        if (prevModeRef.current !== null && prevModeRef.current !== demoMode) {
            prevSnapshotIds.current = null;
            loadedMonth.current = "";
            userPickedMonth.current = false;
        }
        prevModeRef.current = demoMode;

        const seq = ++requestSeq.current;
        const isSilent = silentRefresh.current;
        silentRefresh.current = false;
        const sameMonth = loadedMonth.current === month;

        setError("");
        if (!data && !isSilent) {
            setLoading(true);
        } else if (!isSilent) {
            // Keep existing `data` mounted during month switches so child views (like Calendar) never unmount/reset!
            setRefreshing(true);
        }

        const params = new URLSearchParams();
        if (userPickedMonth.current) params.set("month", month);
        if (isSilent) params.set("_rt", String(Date.now()));
        const query = params.toString() ? `?${params.toString()}` : "";

        get<Data>("/bootstrap" + query)
            .then(res => {
                if (seq !== requestSeq.current || !res) return;
                const startDay = res.settings?.monthly_start_day || 1;
                const resolvedMonth = res.month || cycleMonthForDate(today(), startDay);

                const nextTxs = res.summary?.transactions || res.transactions || [];
                const nextReviews = res.reviews || [];
                const currentIds = new Set<string>([
                    ...nextTxs.map(t => t.id),
                    ...nextReviews.map(r => r.id),
                ]);

                if (prevSnapshotIds.current && sameMonth) {
                    const added = new Set<string>();
                    for (const id of currentIds) {
                        if (!prevSnapshotIds.current.has(id)) added.add(id);
                    }
                    if (added.size > 0) {
                        setRecentIds(added);
                        if (pulseTimer.current) clearTimeout(pulseTimer.current);
                        pulseTimer.current = setTimeout(() => setRecentIds(EMPTY_SET), 3800);
                    }
                }
                prevSnapshotIds.current = currentIds;

                loadedMonth.current = resolvedMonth;
                lastFetchedAt.current = Date.now();
                setData({
                    ...res,
                    reviews: nextReviews,
                    transactions: nextTxs,
                    budgets: res.summary?.budgets || res.budgets || [],
                });

                if (!userPickedMonth.current && resolvedMonth !== month) {
                    setMonthState(resolvedMonth);
                }
            })
            .catch(e => {
                if (seq === requestSeq.current && !isSilent) {
                    setError(e instanceof Error ? e.message : "Gagal memuat data.");
                }
            })
            .finally(() => {
                if (seq === requestSeq.current) {
                    setLoading(false);
                    setRefreshing(false);
                }
            });
    }, [month, ready, demoMode, refreshTick]);

    return {
        month,
        pickMonth,
        data,
        loading,
        refreshing,
        recentIds,
        error,
        setError,
        refresh,
        lastFetchedAt,
    };
}
