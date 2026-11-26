import type { Metadata, Viewport } from "next";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/500.css";
import "@fontsource/dm-sans/600.css";
import "@fontsource/dm-sans/700.css";
import "./globals.css";

export const metadata: Metadata = {
    title: "SamSaku – Keuangan pribadi",
    description: "Ringkasan, transaksi, dan laporan keuangan pribadi.",
    manifest: "/manifest.webmanifest",
    icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = {
    themeColor: "#183d35",
    width: "device-width",
    initialScale: 1,
};

export default function Layout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="id">
            <body>{children}</body>
        </html>
    );
}
