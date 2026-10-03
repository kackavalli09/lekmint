import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatSats(sats: number | string | undefined | null): string {
  return formatAmount(sats)
}

export function formatLeks(leks: number | string | undefined | null): string {
  return formatAmount(leks)
}

/**
 * Display formatter for amounts: standard "1,234,567" grouping regardless of
 * browser locale. Safe on 0, empty, and integers beyond MAX_SAFE_INTEGER
 * (string grouping, no rounding).
 */
export function formatAmount(value: number | string | null | undefined): string {
  if (value == null || value === "") return "0"
  const s = String(value)
  if (!/^-?\d+$/.test(s)) {
    const n = Number(s)
    return Number.isFinite(n) ? n.toLocaleString("en-US") : "0"
  }
  return (s.startsWith("-") ? "-" : "") + groupDigitString(s.replace("-", ""))
}

/** Strip everything but digits (input masking helper). */
export function digitsOnly(value: string): string {
  return value.replace(/\D/g, "")
}

/** Group a digit-only string with commas: "1234567" -> "1,234,567". */
export function groupDigitString(digits: string): string {
  const d = digits.replace(/^0+(?=\d)/, "")
  return d.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}
