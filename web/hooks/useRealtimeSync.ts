"use client";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { getAuthCredentials, wsEndpoint } from "../lib/api";

const VISIBILITY_COOLDOWN_MS = 30_000;
const BASE_RETRY_MS = 1500;
const MAX_RETRY_MS = 30_000;

export type RealtimeSyncEvent = {
    event?: string;
    message?: string;
};

export function computeReconnectDelayMs(attempt: number, rng: () => number = Math.random): number {
    const safeAttempt = Math.max(0, Math.min(attempt, 10));
    const base = Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** safeAttempt);
    const boundedRng = Math.min(1, Math.max(0, rng()));
    const jitter = 0.75 + 0.5 * boundedRng;
    return Math.round(base * jitter);
}

export function useRealtimeSync({
    ready,
    authed,
    demoMode,
    lastFetchedAt,
    onSync,
}: {
    ready: boolean;
    authed: boolean;
    demoMode: boolean;
    lastFetchedAt: MutableRefObject<number>;
    onSync: (info?: RealtimeSyncEvent) => void;
}) {
    const [live, setLive] = useState(false);
    const liveRef = useRef(false);
    const onSyncRef = useRef(onSync);
    onSyncRef.current = onSync;

    useEffect(() => {
        if (!ready || !authed || demoMode) {
            liveRef.current = false;
            setLive(false);
            return;
        }
        const url = wsEndpoint();
        if (!url) return;

        let active = true;
        let ws: WebSocket | null = null;
        let retryAttempt = 0;
        let hasConnectedOnce = false;
        let needsReconcile = false;
        let retryTimer: ReturnType<typeof setTimeout> | null = null;
        let pingTimer: ReturnType<typeof setInterval> | null = null;

        const scheduleReconnect = () => {
            if (!active || retryTimer) return;
            const delay = computeReconnectDelayMs(retryAttempt++);
            retryTimer = setTimeout(() => {
                retryTimer = null;
                connect();
            }, delay);
        };

        const connect = async () => {
            if (!active) return;
            const creds = await getAuthCredentials();
            if (!active || !creds) return;
            try {
                ws = new WebSocket(url);
            } catch {
                scheduleReconnect();
                return;
            }
            ws.onopen = () => {
                if (!active || !ws) return;
                ws.send(JSON.stringify({ type: "auth", ...creds }));
            };
            ws.onmessage = ev => {
                if (!active) return;
                try {
                    const msg = JSON.parse(String(ev.data || "{}"));
                    if (msg.type === "connected") {
                        liveRef.current = true;
                        setLive(true);
                        retryAttempt = 0;
                        if (hasConnectedOnce && needsReconcile) {
                            needsReconcile = false;
                            onSyncRef.current();
                        }
                        hasConnectedOnce = true;
                        if (pingTimer) clearInterval(pingTimer);
                        pingTimer = setInterval(() => {
                            if (ws && ws.readyState === WebSocket.OPEN) {
                                ws.send(JSON.stringify({ type: "ping" }));
                            }
                        }, 25000);
                    } else if (msg.type === "ping") {
                        ws?.send(JSON.stringify({ type: "pong" }));
                    } else if (msg.type === "sync") {
                        const toastMsg =
                            typeof msg.message === "string" && msg.message.trim() ? msg.message.trim() : undefined;
                        const evName = typeof msg.event === "string" ? msg.event : undefined;
                        onSyncRef.current({ event: evName, message: toastMsg });
                    }
                } catch {}
            };
            ws.onclose = () => {
                if (!active) return;
                if (hasConnectedOnce) {
                    needsReconcile = true;
                }
                liveRef.current = false;
                setLive(false);
                if (pingTimer) {
                    clearInterval(pingTimer);
                    pingTimer = null;
                }
                scheduleReconnect();
            };
            ws.onerror = () => {
                ws?.close();
            };
        };

        const onVisible = () => {
            if (document.visibilityState !== "visible") return;
            const stale = Date.now() - lastFetchedAt.current > VISIBILITY_COOLDOWN_MS;
            if (!liveRef.current || stale) {
                onSyncRef.current();
            }
            if (!ws || ws.readyState === WebSocket.CLOSED) connect();
        };

        const onOffline = () => {
            needsReconcile = true;
        };

        const onOnline = () => {
            if (!active) return;
            retryAttempt = 0;
            needsReconcile = false;
            if (retryTimer) {
                clearTimeout(retryTimer);
                retryTimer = null;
            }
            onSyncRef.current();
            if (!ws || ws.readyState === WebSocket.CLOSED) connect();
        };

        connect();
        document.addEventListener("visibilitychange", onVisible);
        window.addEventListener("online", onOnline);
        window.addEventListener("offline", onOffline);
        return () => {
            active = false;
            liveRef.current = false;
            setLive(false);
            document.removeEventListener("visibilitychange", onVisible);
            window.removeEventListener("online", onOnline);
            window.removeEventListener("offline", onOffline);
            if (retryTimer) clearTimeout(retryTimer);
            if (pingTimer) clearInterval(pingTimer);
            ws?.close();
        };
    }, [ready, authed, demoMode, lastFetchedAt]);

    return { live };
}
