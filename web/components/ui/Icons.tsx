"use client";
import {
    CarFront,
    CircleDollarSign,
    Coins,
    Landmark,
    ReceiptText,
    ShoppingBag,
    Smartphone,
    UtensilsCrossed,
    Wallet,
} from "lucide-react";

export function CatIcon({ name, size = 17 }: { name: string; size?: number }) {
    const Icon = /makan|kopi|minum|resto|kuliner/i.test(name)
        ? UtensilsCrossed
        : /belanja|shop|mart/i.test(name)
          ? ShoppingBag
          : /transport|jalan|bensin/i.test(name)
            ? CarFront
            : /tagih|listrik|air|pulsa/i.test(name)
              ? ReceiptText
              : /gaji|income|bonus/i.test(name)
                ? CircleDollarSign
                : Wallet;
    return <Icon size={size} strokeWidth={1.7} />;
}

export function WalletIcon({ kind, name, size = 17 }: { kind?: string; name: string; size?: number }) {
    const Icon =
        kind === "bank" || /bca|bank|mandiri|bri|bni|jago|cimb/i.test(name)
            ? Landmark
            : kind === "cash" || /tunai|cash|kas/i.test(name)
              ? Coins
              : Smartphone;
    return <Icon size={size} />;
}
