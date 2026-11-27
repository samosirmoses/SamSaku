"use client";
import { CatIcon } from "../../components/ui";
import { type Data, money } from "../../lib/domain";

export function CategoriesBreakdown({
    data,
    limit,
    onSelect,
}: {
    data: Data;
    limit?: number;
    onSelect: (name: string) => void;
}) {
    const allCats = data.summary.categories.filter(c => c.amount > 0).sort((a, b) => b.amount - a.amount);
    const cats = limit ? allCats.slice(0, limit) : allCats;
    const budgetsByName = new Map((data.budgets || []).map(b => [b.category_name, b]));

    return (
        <div className="categories">
            {cats.length ? (
                cats.map((c, i) => {
                    const b = budgetsByName.get(c.name);
                    const pct = data.summary.expense > 0 ? Math.round((100 * c.amount) / data.summary.expense) : 0;
                    return (
                        <button key={c.name} className="category-row" onClick={() => onSelect(c.name)}>
                            <span className="cat-icon">
                                <CatIcon name={c.name} />
                            </span>
                            <span className="category-text">
                                <span className="category-label">
                                    <strong>{c.name}</strong>
                                    <b>{money(c.amount)}</b>
                                </span>
                                <span className="bar-line">
                                    <span className="bar-track">
                                        <span
                                            className={
                                                "bar " +
                                                (b
                                                    ? b.status === "over"
                                                        ? "bar-over"
                                                        : b.status === "warning"
                                                          ? "bar-warn"
                                                          : "bar-safe"
                                                    : "bar-" + (i % 5))
                                            }
                                            style={{
                                                width:
                                                    Math.min(
                                                        100,
                                                        Math.max(2, b ? b.percent : (100 * c.amount) / cats[0].amount)
                                                    ) + "%",
                                            }}
                                        />
                                    </span>
                                    <small>{b ? `${b.percent}% dari anggaran` : `${pct}%`}</small>
                                </span>
                            </span>
                        </button>
                    );
                })
            ) : (
                <p className="empty">Kategori pengeluaran muncul setelah transaksi pertama.</p>
            )}
        </div>
    );
}
