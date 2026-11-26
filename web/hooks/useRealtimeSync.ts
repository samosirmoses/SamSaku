"use client";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { getAuthCredentials, wsEndpoint } from "../lib/api";

const VISIBILITY_COOLDOWN_MS = 30_000;

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
    onSync: (message?: string) => void;
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
        let retryDelay = 2000;
        let retryTimer: ReturnType<typeof setTimeout> | null = null;
        let pingTimer: ReturnType<typeof setInterval> | null = null;

        const scheduleReconnect = () => {
            if (!active || retryTimer) return;
            retryTimer = setTimeout(() => {
                retryTimer = null;
                retryDelay = Math.min(retryDelay * 1.5, 15000);
                connect();
            }, retryDelay);
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
                        retryDelay = 2000;
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
                        onSyncRef.current(toastMsg);
                    }
                } catch {}
            };
            ws.onclose = () => {
                if (!active) return;
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

        connect();
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            active = false;
            liveRef.current = false;
            setLive(false);
            document.removeEventListener("visibilitychange", onVisible);
            if (retryTimer) clearTimeout(retryTimer);
            if (pingTimer) clearInterval(pingTimer);
            ws?.close();
        };
    }, [ready, authed, demoMode, lastFetchedAt]);

    return { live };
}
