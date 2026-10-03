import { twMerge } from 'tailwind-merge';

import { clsx, type ClassValue } from 'clsx';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Display formatter for amounts (leks / sats): standard "1,234,567"
 * grouping regardless of the browser locale. Safe on 0, empty, and
 * values beyond Number.MAX_SAFE_INTEGER (string grouping, no rounding).
 */
export function formatAmount(value: number | string | null | undefined): string {
  if (value == null || value === "") return "0";
  const s = String(value);
  if (!/^-?\d+$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? n.toLocaleString("en-US") : "0";
  }
  return groupDigitString(s.replace("-", "")).replace(/^/, s.startsWith("-") ? "-" : "");
}

/** Strip everything but digits (input masking helper). */
export function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

/** Group a digit-only string with commas: "1234567" -> "1,234,567". */
export function groupDigitString(digits: string): string {
  const d = digits.replace(/^0+(?=\d)/, "");
  return d.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
