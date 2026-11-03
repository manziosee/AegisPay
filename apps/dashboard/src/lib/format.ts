import type { Role } from "./types";

const FRACTION_OVERRIDES: Record<string, number> = {
  RWF: 0,
  JPY: 0,
  KRW: 0,
  KWD: 3,
  BHD: 3,
  JOD: 3,
  OMR: 3
};

export function currencyFractionDigits(currency: string): number {
  const code = currency.trim().toUpperCase();
  if (code in FRACTION_OVERRIDES) return FRACTION_OVERRIDES[code];
  try {
    return (
      new Intl.NumberFormat("en", {
        style: "currency",
        currency: code
      }).resolvedOptions().maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

export function formatMinor(amountMinor: number, currency: string): string {
  const code = currency.trim().toUpperCase();
  const digits = currencyFractionDigits(code);
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency: code,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    }).format(amountMinor / 10 ** digits);
  } catch {
    return `${amountMinor.toLocaleString("en")} ${code} minor`;
  }
}

export function formatMinorPlain(amountMinor: number, currency: string): string {
  const code = currency.trim().toUpperCase();
  const digits = currencyFractionDigits(code);
  const value = amountMinor / 10 ** digits;
  return `${value.toLocaleString("en", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  })} ${code}`;
}

export function minorHint(value: string, currency: string): string {
  const parsed = Number(value);
  if (!value.trim() || !Number.isFinite(parsed) || parsed <= 0) return "";
  const minor = Math.round(parsed * 10 ** currencyFractionDigits(currency));
  return `${minor.toLocaleString("en")} minor units`;
}

export function majorToMinor(value: string, currency: string): number | null {
  const parsed = Number(value);
  if (!value.trim() || !Number.isFinite(parsed) || parsed <= 0) return null;
  const minor = Math.round(parsed * 10 ** currencyFractionDigits(currency));
  return Number.isSafeInteger(minor) ? minor : null;
}

export function minorToMajorInput(amountMinor: number | null | undefined, currency: string): string {
  if (amountMinor == null) return "";
  const digits = currencyFractionDigits(currency);
  const value = amountMinor / 10 ** digits;
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(date);
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function formatRelative(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const diff = Date.now() - date.getTime();
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(date);
}

export function statusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  return status.replaceAll("_", " ");
}

export function roleLabel(role: Role | string): string {
  if (!role) return "Member";
  const label = statusLabel(role);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function titleCase(value: string): string {
  return value.replace(/\b\w/g, (character) => character.toUpperCase());
}

export function truncateMiddle(value: string, size = 20): string {
  if (!value) return "";
  if (value.length <= size) return value;
  const head = Math.ceil(size / 2);
  const tail = Math.floor(size / 2);
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function percent(value: number, total: number): string {
  if (!total) return "—";
  return `${Math.round((value / total) * 100)}%`;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function initials(name?: string): string {
  if (!name) return "U";
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part.charAt(0).toUpperCase()).join("") || "U";
}

export function firstName(name?: string): string {
  if (!name) return "there";
  return name.trim().split(/\s+/)[0] || "there";
}

export function greeting(date = new Date()): string {
  const hour = date.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export function toISODateParam(date: Date): string {
  return date.toISOString();
}

export function dateRangeDays(days: number) {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - days);
  return { from, to };
}
