"use client";
import dynamic from "next/dynamic";
import type { Account, Category, Data, Review, Transaction } from "../../lib/domain";
import { Modal } from "../ui";

const LoginModal = dynamic(() => import("../../features/auth/LoginModal").then(m => m.LoginModal));
const EntryForm = dynamic(() => import("../../features/transactions/EntryForm").then(m => m.EntryForm));
const TransactionDetailModal = dynamic(
    () => import("../../features/transactions/TransactionDetailModal").then(m => m.TransactionDetailModal)
);
const MasterForm = dynamic(() => import("../../features/masters/MasterForm").then(m => m.MasterForm));
const CategoryEdit = dynamic(() => import("../../features/masters/CategoryEdit").then(m => m.CategoryEdit));
const ReviewModal = dynamic(() => import("../../features/reviews/ReviewModal").then(m => m.ReviewModal));

export type Dialog =
    | "login"
    | "entry"
    | "edit-entry"
    | "account"
    | "edit-account"
    | "category"
    | "edit-category"
    | "detail"
    | "review"
    | "receipt"
    | null;

export type EntryPreset = {
    date?: string;
    kind?: Transaction["kind"];
    account_id?: string;
    autoScan?: boolean;
};

export function AppDialogs({
    dialog,
    entryPreset,
    authed,
    data,
    selectedTx,
    selectedAccount,
    selectedCategory,
    selectedReview,
    onClose,
    onOpenDialog,
    onFinishMutation,
    onRefresh,
    onConnected,
    onLogout,
    onError,
}: {
    dialog: Dialog;
    entryPreset: EntryPreset;
    authed: boolean;
    data: Data | null;
    selectedTx: Transaction | null;
    selectedAccount: Account | null;
    selectedCategory: Category | null;
    selectedReview: Review | null;
    onClose: () => void;
    onOpenDialog: (d: Dialog) => void;
    onFinishMutation: (msg?: string) => void;
    onRefresh: (silent?: boolean) => void;
    onConnected: () => void;
    onLogout: () => Promise<void>;
    onError: (msg: string) => void;
}) {
    if (!dialog) return null;

    const dialogTitles: Record<Exclude<Dialog, null>, string> = {
        login: "Koneksi Server & Akun",
        entry:
            entryPreset.kind === "transfer"
                ? "Transfer Antar Dompet"
                : entryPreset.kind === "income"
                  ? "Catat Pemasukan"
                  : "Catat Transaksi",
        "edit-entry": "Ubah Transaksi",
        account: "Tambah Dompet Baru",
        "edit-account": "Ubah / Hapus Dompet",
        category: "Buat Kategori Baru",
        "edit-category": "Ubah / Hapus Kategori",
        detail: "Detail Transaksi",
        review: "Tinjau Bukti",
        receipt: "Foto Struk (Auto-Fill)",
    };

    return (
        <Modal
            title={dialogTitles[dialog]}
            onClose={onClose}
            wide={["entry", "edit-entry", "receipt", "account", "edit-account"].includes(dialog)}
            key={dialog}
        >
            {dialog === "login" && <LoginModal authed={authed} onLogout={onLogout} onConnected={onConnected} />}

            {data && (
                <>
                    {dialog === "entry" && (
                        <EntryForm
                            data={data}
                            initial={{
                                date: entryPreset.date,
                                kind: entryPreset.kind,
                                account_id: entryPreset.account_id,
                            }}
                            autoScan={entryPreset.autoScan}
                            onSavedKeepOpen={() => onRefresh(true)}
                            onDone={() => onFinishMutation("Transaksi tersimpan.")}
                        />
                    )}

                    {dialog === "edit-entry" && selectedTx && (
                        <EntryForm
                            data={data}
                            tx={selectedTx}
                            onDone={() => onFinishMutation("Perubahan transaksi disimpan.")}
                        />
                    )}

                    {dialog === "account" && (
                        <MasterForm mode="account" data={data} onDone={() => onFinishMutation()} />
                    )}

                    {dialog === "edit-account" && selectedAccount && (
                        <MasterForm
                            mode="account"
                            data={data}
                            account={selectedAccount}
                            onDone={() => onFinishMutation()}
                        />
                    )}

                    {dialog === "category" && (
                        <MasterForm mode="category" data={data} onDone={() => onFinishMutation()} />
                    )}

                    {dialog === "detail" && selectedTx && (
                        <TransactionDetailModal
                            doc={selectedTx}
                            data={data}
                            onEdit={() => onOpenDialog("edit-entry")}
                            onDeleted={() => onFinishMutation("Transaksi dihapus.")}
                            onError={onError}
                        />
                    )}

                    {dialog === "edit-category" && selectedCategory && (
                        <CategoryEdit
                            category={selectedCategory}
                            categories={data.categories}
                            done={() => onFinishMutation()}
                        />
                    )}

                    {dialog === "receipt" && (
                        <EntryForm
                            data={data}
                            initial={{ date: entryPreset.date, kind: "expense" }}
                            autoScan={true}
                            onSavedKeepOpen={() => onRefresh(true)}
                            onDone={() => onFinishMutation("Transaksi tersimpan.")}
                        />
                    )}

                    {dialog === "review" && selectedReview && (
                        <ReviewModal
                            r={selectedReview}
                            data={data}
                            done={() => onFinishMutation("Bukti berhasil diproses.")}
                        />
                    )}
                </>
            )}
        </Modal>
    );
}
