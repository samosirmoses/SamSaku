"use client";
import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, FolderTree, Plus, Search, Sparkles, X } from "lucide-react";
import { CatIcon } from "../../components/ui";
import { post } from "../../lib/api";
import { type Category, type Transaction, frequentCategories } from "../../lib/domain";

export function CategoryPicker({
    categories,
    transactions,
    kind,
    value,
    autoSuggested = false,
    disabled = false,
    onChange,
    onCategoryCreated,
    onError,
}: {
    categories: Category[];
    transactions: Transaction[];
    kind: "expense" | "income";
    value: string;
    autoSuggested?: boolean;
    disabled?: boolean;
    onChange: (nextId: string, manual: boolean) => void;
    onCategoryCreated: (cat: Category) => void;
    onError: (msg: string) => void;
}) {
    const [expanded, setExpanded] = useState(false);
    const [search, setSearch] = useState("");
    const [creating, setCreating] = useState(false);
    const [showNewInput, setShowNewInput] = useState(false);
    const [newName, setNewName] = useState("");

    const activeCats = useMemo(
        () => categories.filter(c => !c.archived && c.kind === kind),
        [categories, kind]
    );

    const quickCats = useMemo(
        () => frequentCategories(categories, transactions, kind, value, 7),
        [categories, transactions, kind, value]
    );

    const selectedCat = activeCats.find(c => c.id === value) || null;
    const activeParentId = selectedCat ? selectedCat.parent_id || selectedCat.id : "";
    const activeParent = activeCats.find(c => c.id === activeParentId && !c.parent_id) || null;
    const subCategoriesOfActive = useMemo(
        () => (activeParent ? activeCats.filter(c => c.parent_id === activeParent.id) : []),
        [activeCats, activeParent]
    );

    const grouped = useMemo(() => {
        const needle = search.trim().toLowerCase();
        const matching = needle
            ? activeCats.filter(c => {
                  const parentName = c.parent_id
                      ? activeCats.find(p => p.id === c.parent_id)?.name.toLowerCase() || ""
                      : "";
                  return c.name.toLowerCase().includes(needle) || parentName.includes(needle);
              })
            : activeCats;

        const parents = activeCats.filter(c => !c.parent_id);
        const groups: { parent: Category; children: Category[] }[] = [];
        const standalone: Category[] = [];

        for (const p of parents) {
            const allKids = activeCats.filter(c => c.parent_id === p.id);
            if (allKids.length > 0) {
                const visibleKids = matching.filter(c => c.parent_id === p.id);
                const parentMatches = matching.some(c => c.id === p.id);
                if (parentMatches || visibleKids.length > 0) {
                    groups.push({ parent: p, children: parentMatches && !needle ? allKids : visibleKids });
                }
            } else if (matching.some(c => c.id === p.id)) {
                standalone.push(p);
            }
        }

        // Orphaned subcategories whose parent was archived/missing
        for (const c of matching) {
            if (c.parent_id && !parents.some(p => p.id === c.parent_id)) {
                standalone.push(c);
            }
        }

        return { groups, standalone, totalMatching: matching.length };
    }, [activeCats, search]);

    const exactSearchExists = useMemo(() => {
        const clean = search.trim().toLowerCase();
        if (!clean) return true;
        return activeCats.some(c => c.name.trim().toLowerCase() === clean);
    }, [activeCats, search]);

    async function createQuickCategory(rawName: string) {
        const name = rawName.trim();
        if (!name || creating) return;
        setCreating(true);
        onError("");
        try {
            const created = await post<Category>("/categories", {
                name,
                code: name.toUpperCase().replace(/[^A-Z0-9]+/g, "-").slice(0, 40) || "CAT",
                kind,
            });
            onCategoryCreated(created);
            onChange(created.id, true);
            setNewName("");
            setSearch("");
            setShowNewInput(false);
            setExpanded(false);
        } catch (err) {
            onError(err instanceof Error ? err.message : "Gagal membuat kategori baru.");
        } finally {
            setCreating(false);
        }
    }

    const hasMoreCategories = activeCats.length > quickCats.length;

    return (
        <div className="field cat-picker-wrap">
            <div className="cat-picker-header">
                <span>
                    Pilih Kategori
                    {selectedCat && autoSuggested && (
                        <em className="cat-auto-badge">
                            <Sparkles size={11} /> Otomatis: {selectedCat.name}
                        </em>
                    )}
                </span>
                <div className="cat-picker-actions">
                    {hasMoreCategories && (
                        <button
                            type="button"
                            className={"cat-expand-btn " + (expanded ? "active" : "")}
                            onClick={() => setExpanded(v => !v)}
                        >
                            {expanded ? (
                                <>
                                    Tutup daftar <ChevronUp size={13} />
                                </>
                            ) : (
                                <>
                                    Semua / Cari ({activeCats.length}) <ChevronDown size={13} />
                                </>
                            )}
                        </button>
                    )}
                </div>
            </div>

            {!expanded && (
                <>
                    <div className="cat-chip-grid">
                        {quickCats.map(c => {
                            const parent = c.parent_id ? activeCats.find(p => p.id === c.parent_id) : null;
                            return (
                                <button
                                    type="button"
                                    key={c.id}
                                    disabled={disabled}
                                    className={`cat-pick-chip ${kind} ${value === c.id ? "active" : ""}`}
                                    onClick={() => onChange(value === c.id ? "" : c.id, true)}
                                >
                                    <CatIcon name={c.name} size={15} />
                                    <span>{parent ? `${parent.name} › ${c.name}` : c.name}</span>
                                </button>
                            );
                        })}

                        {hasMoreCategories ? (
                            <button
                                type="button"
                                className="cat-pick-chip more-btn"
                                onClick={() => setExpanded(true)}
                            >
                                <Search size={14} />
                                <span>Lainnya ({activeCats.length - quickCats.length})</span>
                            </button>
                        ) : (
                            <button
                                type="button"
                                className="cat-pick-chip add-new"
                                onClick={() => setShowNewInput(v => !v)}
                            >
                                <Plus size={14} />
                                <span>Baru</span>
                            </button>
                        )}
                    </div>

                    {activeParent && subCategoriesOfActive.length > 0 && (
                        <div className="subcat-inline-bar">
                            <small className="subcat-inline-label">
                                <FolderTree size={12} /> Subkategori {activeParent.name}:
                            </small>
                            <div className="cat-chip-grid compact">
                                <button
                                    type="button"
                                    className={`cat-pick-chip sm ${value === activeParent.id ? "active" : ""}`}
                                    onClick={() => onChange(activeParent.id, true)}
                                >
                                    Umum ({activeParent.name})
                                </button>
                                {subCategoriesOfActive.map(sub => (
                                    <button
                                        type="button"
                                        key={sub.id}
                                        className={`cat-pick-chip sm ${value === sub.id ? "active" : ""}`}
                                        onClick={() => onChange(sub.id, true)}
                                    >
                                        {sub.name}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                </>
            )}

            {expanded && (
                <div className="cat-browser-panel">
                    <div className="cat-search-bar">
                        <Search size={15} />
                        <input
                            type="text"
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder="Cari kategori atau ketik nama baru…"
                            autoFocus
                        />
                        {search && (
                            <button
                                type="button"
                                className="icon-btn sm-icon"
                                aria-label="Bersihkan pencarian"
                                onClick={() => setSearch("")}
                            >
                                <X size={14} />
                            </button>
                        )}
                    </div>

                    <div className="cat-groups-scroll">
                        {grouped.standalone.length > 0 && (
                            <div className="cat-group-block">
                                {grouped.groups.length > 0 && <small className="cat-group-title">Kategori Utama</small>}
                                <div className="cat-chip-grid">
                                    {grouped.standalone.map(c => (
                                        <button
                                            type="button"
                                            key={c.id}
                                            className={`cat-pick-chip ${kind} ${value === c.id ? "active" : ""}`}
                                            onClick={() => {
                                                onChange(value === c.id ? "" : c.id, true);
                                                setExpanded(false);
                                            }}
                                        >
                                            <CatIcon name={c.name} size={14} />
                                            <span>{c.name}</span>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}

                        {grouped.groups.map(({ parent, children }) => (
                            <div key={parent.id} className="cat-group-block">
                                <div className="cat-group-header">
                                    <button
                                        type="button"
                                        className={`cat-parent-pill ${value === parent.id ? "active" : ""}`}
                                        onClick={() => {
                                            onChange(value === parent.id ? "" : parent.id, true);
                                            setExpanded(false);
                                        }}
                                    >
                                        <CatIcon name={parent.name} size={14} />
                                        <strong>{parent.name}</strong>
                                    </button>
                                </div>
                                <div className="cat-chip-grid sub-grid">
                                    {children.map(sub => (
                                        <button
                                            type="button"
                                            key={sub.id}
                                            className={`cat-pick-chip sm ${value === sub.id ? "active" : ""}`}
                                            onClick={() => {
                                                onChange(value === sub.id ? "" : sub.id, true);
                                                setExpanded(false);
                                            }}
                                        >
                                            <span>{sub.name}</span>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        ))}

                        {grouped.totalMatching === 0 && !search.trim() && (
                            <p className="empty" style={{ padding: "6px 0" }}>
                                Belum ada kategori untuk jenis ini.
                            </p>
                        )}
                    </div>

                    <div className="cat-browser-footer">
                        {search.trim() && !exactSearchExists ? (
                            <button
                                type="button"
                                className="btn primary sm"
                                disabled={creating}
                                onClick={() => createQuickCategory(search)}
                            >
                                <Plus size={14} /> {creating ? "Menyimpan…" : `Buat kategori "${search.trim()}"`}
                            </button>
                        ) : (
                            <button
                                type="button"
                                className="text-btn"
                                onClick={() => setShowNewInput(v => !v)}
                            >
                                <Plus size={14} /> Buat kategori baru
                            </button>
                        )}
                    </div>
                </div>
            )}

            {showNewInput && (
                <div className="inline-add">
                    <input
                        aria-label="Nama kategori baru"
                        value={newName}
                        onChange={e => setNewName(e.target.value)}
                        placeholder="Ketik nama kategori baru…"
                        onKeyDown={e => {
                            if (e.key === "Enter") {
                                e.preventDefault();
                                createQuickCategory(newName);
                            }
                        }}
                    />
                    <button
                        className="btn primary sm"
                        type="button"
                        disabled={creating || !newName.trim()}
                        onClick={() => createQuickCategory(newName)}
                    >
                        {creating ? "Menyimpan…" : "Simpan"}
                    </button>
                </div>
            )}
        </div>
    );
}
