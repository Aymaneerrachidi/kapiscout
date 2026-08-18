import { formatUnits, getAddress, isAddress, type Address } from "viem";

const ADDRESS_PATTERN = /0x[a-fA-F0-9]{40}/g;

export function extractAddresses(text: string): Address[] {
  const found = text.match(ADDRESS_PATTERN) ?? [];
  return [...new Set(found.filter((item) => isAddress(item)).map((item) => getAddress(item)))];
}

export function commandArgument(text: string | undefined): string {
  if (!text) return "";
  return text.replace(/^\/\w+(?:@\w+)?\s*/u, "").trim();
}

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function compactAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function formatUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "N/A";
  const absolute = Math.abs(value);
  if (absolute === 0) return "$0";
  if (absolute < 0.000001) return `$${value.toExponential(2)}`;
  if (absolute < 0.01) return `$${value.toPrecision(3)}`;
  const units = [
    { threshold: 1e12, suffix: "T" },
    { threshold: 1e9, suffix: "B" },
    { threshold: 1e6, suffix: "M" },
    { threshold: 1e3, suffix: "K" },
  ];
  for (const unit of units) {
    if (absolute >= unit.threshold) return `$${trimZeros((value / unit.threshold).toFixed(2))}${unit.suffix}`;
  }
  return `$${trimZeros(value.toFixed(2))}`;
}

export function formatTokenPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "N/A";
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  if (absolute === 0) return "$0";
  if (absolute >= 0.0001) return formatUsd(value);
  const fraction = absolute.toFixed(20).split(".")[1] ?? "";
  const zeroCount = fraction.match(/^0*/u)?.[0].length ?? 0;
  const significant = fraction.slice(zeroCount, zeroCount + 4).replace(/0+$/u, "") || "0";
  return `${sign}$0.0${toSubscript(zeroCount)}${significant}`;
}

export function formatCompactNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "N/A";
  const absolute = Math.abs(value);
  for (const unit of [
    { threshold: 1e12, suffix: "T" },
    { threshold: 1e9, suffix: "B" },
    { threshold: 1e6, suffix: "M" },
    { threshold: 1e3, suffix: "K" },
  ]) {
    if (absolute >= unit.threshold * 0.9995) {
      return `${trimZeros((value / unit.threshold).toFixed(absolute >= unit.threshold * 100 ? 0 : 1))}${unit.suffix}`;
    }
  }
  return Math.round(value).toLocaleString();
}

export function formatTokenSupply(raw: bigint, decimals: number): string {
  const numeric = Number(formatUnits(raw, decimals));
  return Number.isFinite(numeric) ? formatCompactNumber(numeric) : "N/A";
}

export function formatPercent(value: number | null | undefined, signed = false): string {
  if (value == null || !Number.isFinite(value)) return "N/A";
  const prefix = signed && value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(2)}%`;
}

export function formatAge(timestampMs: number | null): string {
  if (!timestampMs) return "Unknown";
  const seconds = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function calculateReturn(entry: number | null, current: number | null): number | null {
  if (entry == null || current == null || entry <= 0) return null;
  return ((current - entry) / entry) * 100;
}

export function calculateMultiple(entry: number | null, current: number | null): number | null {
  if (entry == null || current == null || entry <= 0) return null;
  return current / entry;
}

function toSubscript(value: number): string {
  const digits: Record<string, string> = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉" };
  return String(value).split("").map((digit) => digits[digit] ?? digit).join("");
}

function trimZeros(value: string): string {
  return value.includes(".") ? value.replace(/\.0+$/u, "").replace(/(\.\d*?)0+$/u, "$1") : value;
}
