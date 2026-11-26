"use client";
import { FileSpreadsheet, Pencil, Plus } from "lucide-react";
import { type Account, type Category, type Data, kindLabels } from "../../lib/domain";
import { AccountsSection } from "../dashboard/AccountsSection";

export function MastersView({
    data,
    onEditAccount,
    onAddAccount,
    onTransfer,
    onFilterAccount,
    onAddCategory,
    onEditCategory,
    onOpenImport,
}: {
    data: Data;
    onEditAccount: (a: Account) => void;
    onAddAccount: () => void;
    onTransfer: (fromAccId?: string) => void;
    onFilterAccount: (accId: string) => void;
    onAddCategory: () => void;
    onEditCategory: (c: Category) => void;
    onOpenImport: () => void;
}) {
    return (
        <div className="two-cols">
            <div className="stack">
                <AccountsSection
                    data={data}
                    onEdit={onEditAccount}
                    onTransfer={onTransfer}
                    onFilterAccount={onFilterAccount}
                    onAdd={onAddAccount}
                />
                {data.connections && (
                    <section className="card">
                        <div className="section-title">
                            <h2>Sumber transaksi otomatis</h2>
                        </div>
                        {data.connections.map(c => (
                            <div key={c.source} className="paper-line">
                                <span>{c.source.toUpperCase()}</span>
                                <small>
                                    {c.last_received_at
                                        ? new Date(c.last_received_at).toLocaleString("id-ID", {
                                              timeZone: "Asia/Jakarta",
                                          })
                                        : "Belum ada bukti"}
                                </small>
                            </div>
                        ))}
                    </section>
                )}
            </div>
            <section className="card">
                <div className="section-title">
                    <h2>Kategori</h2>
                    <button className="btn primary sm" aria-label="Buat kategori" onClick={onAddCategory}>
                        <Plus size={14} /> Kategori
                    </button>
                </div>
                {(["income", "expense"] as const).map(k => (
                    <div key={k} className="master-group">
                        <h3 className={k === "income" ? "income" : "expense-amt"}>{kindLabels[k]}</h3>
                        {data.categories
                            .filter(c => c.kind === k)
                            .map(c => (
                                <button
                                    className="list-action master-cat-row"
                                    key={c.id}
                                    onClick={() => onEditCategory(c)}
                                >
                                    <span>
                                        {c.parent_id ? "↳ " : ""}
                                        {c.name}
                                        {c.archived ? " · Diarsipkan" : ""}
                                    </span>
                                    <Pencil size={14} className="wallet-edit-icon" />
                                </button>
                            ))}
                    </div>
                ))}
                <button className="text-btn" onClick={onOpenImport}>
                    <FileSpreadsheet size={15} /> Impor master dari Excel
                </button>
            </section>
        </div>
    );
}
