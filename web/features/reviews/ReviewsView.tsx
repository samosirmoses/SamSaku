"use client";
import { Inbox } from "lucide-react";
import type { Review } from "../../lib/domain";

export function ReviewsView({ reviews, onSelect }: { reviews: Review[]; onSelect: (r: Review) => void }) {
    return (
        <section className="card">
            <div className="section-title">
                <h2>Bukti menunggu keputusan</h2>
                <Inbox size={18} />
            </div>
            {reviews.length ? (
                reviews.map(r => (
                    <button key={r.id} className="list-action" onClick={() => onSelect(r)}>
                        <strong>{r.source}</strong>
                        <small>{r.text}</small>
                    </button>
                ))
            ) : (
                <p className="empty">Semua bukti sudah ditinjau.</p>
            )}
        </section>
    );
}
