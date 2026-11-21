import React from "react";
import { ZERO_ADDRESS } from "./chains";

/**
 * Deterministic Monochrome Obsidian Identicon Generator
 * Produces crisp geometric SVG avatars directly from wallet address bytes.
 * Zero network requests, zero colored pill fills.
 */
export function generateIdenticonSvg(address: string, size: number = 44): string {
  const clean = (address || ZERO_ADDRESS)
    .toLowerCase()
    .replace(/^0x/, "")
    .padEnd(40, "0");

  const c1 = Number.parseInt(clean.slice(0, 2), 16) || 16;
  const c2 = Number.parseInt(clean.slice(2, 4), 16) || 32;
  const c3 = Number.parseInt(clean.slice(4, 6), 16) || 64;
  const c4 = Number.parseInt(clean.slice(6, 8), 16) || 96;

  const shades = ["#27272A", "#3F3F46", "#52525B", "#71717A", "#A1A1AA", "#E4E4E7"];
  const shade1 = shades[c1 % shades.length];
  const shade2 = shades[c2 % shades.length];
  const shade3 = shades[c3 % shades.length];

  const cx1 = 12 + (c1 % 22);
  const cy1 = 12 + (c2 % 22);
  const r1 = 8 + (c3 % 9);

  const cx2 = 16 + (c4 % 18);
  const cy2 = 16 + (c1 % 18);
  const r2 = 5 + (c2 % 7);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="${size}" height="${size}">
  <rect width="48" height="48" rx="12" fill="#141418" />
  <circle cx="${cx1}" cy="${cy1}" r="${r1}" fill="${shade1}" opacity="0.85" />
  <circle cx="${cx2}" cy="${cy2}" r="${r2}" fill="${shade2}" opacity="0.9" />
  <rect x="${10 + (c3 % 14)}" y="${10 + (c4 % 14)}" width="12" height="12" rx="3" fill="${shade3}" opacity="0.65" />
  <circle cx="24" cy="24" r="2.8" fill="#FFFFFF" />
  <rect width="48" height="48" rx="12" fill="none" stroke="#26262E" stroke-width="1.5" />
</svg>`;
}

export function generateIdenticonDataUri(address: string, size: number = 44): string {
  const svg = generateIdenticonSvg(address, size);
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export interface WalletIdenticonProps {
  address: string;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}

export const WalletIdenticon: React.FC<WalletIdenticonProps> = ({
  address,
  size = 38,
  className = "",
  style = {}
}) => {
  const dataUri = React.useMemo(() => generateIdenticonDataUri(address, size), [address, size]);

  return React.createElement("img", {
    src: dataUri,
    alt: address ? `Wallet ${address.slice(0, 6)}` : "Wallet",
    width: size,
    height: size,
    className: `walletIdenticon ${className}`.trim(),
    style: {
      width: size,
      height: size,
      borderRadius: 10,
      flexShrink: 0,
      ...style
    }
  });
};
