"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

export function Modal({
    title,
    children,
    onClose,
    wide = false,
}: {
    title: string;
    children: ReactNode;
    onClose: () => void;
    wide?: boolean;
}) {
    const ref = useRef<HTMLDialogElement>(null);
    const closeRef = useRef(onClose);
    closeRef.current = onClose;

    useEffect(() => {
        const d = ref.current;
        const origin = document.activeElement as HTMLElement | null;
        d?.showModal();
        const old = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        return () => {
            document.body.style.overflow = old;
            d?.close();
            origin?.focus();
        };
    }, []);

    return (
        <dialog
            className={wide ? "dialog wide-dialog" : "dialog"}
            ref={ref}
            aria-labelledby="dialog-title"
            onCancel={e => {
                e.preventDefault();
                closeRef.current?.();
            }}
            onClick={e => {
                if (e.target === e.currentTarget) {
                    const r = e.currentTarget.getBoundingClientRect();
                    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
                        onClose();
                    }
                }
            }}
        >
            <div className="dialog-header">
                <h2 id="dialog-title">{title}</h2>
                <button className="icon-btn" aria-label="Tutup" onClick={onClose}>
                    <X size={20} />
                </button>
            </div>
            <div className="dialog-body">{children}</div>
        </dialog>
    );
}
