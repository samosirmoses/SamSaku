"use client";
import type { ReactNode } from "react";
import { AlertCircle } from "lucide-react";

export function ErrorNote({ message }: { message: string }) {
    return message ? (
        <p className="error-note" role="alert">
            <AlertCircle size={17} />
            <span>{message}</span>
        </p>
    ) : null;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
    return (
        <label className="field">
            <span>{label}</span>
            {children}
        </label>
    );
}
