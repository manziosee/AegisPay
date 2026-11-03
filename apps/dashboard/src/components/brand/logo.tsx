import { cn } from "@/lib/utils";

type MarkProps = {
  size?: number;
  className?: string;
  tone?: "dark" | "light";
};

/**
 * Aegis mark: the A is drawn as two ledger strokes that never merge, with a
 * mint "checker" stroke and node — maker, checker, and the record between them.
 */
export function AegisMark({ size = 34, className, tone = "dark" }: MarkProps) {
  const stroke = tone === "dark" ? "#F2F4F8" : "#080C18";
  const tile = tone === "dark" ? "#111A2E" : "#080C18";
  const border = tone === "dark" ? "rgba(255,255,255,0.14)" : "rgba(8,12,24,0.08)";

  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      className={cn("shrink-0", className)}
    >
      <rect x="0.5" y="0.5" width="39" height="39" rx="10" fill={tile} stroke={border} />
      <path
        d="M11 29 20 9l9 20"
        stroke={stroke}
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M14.7 22.2h10.6" stroke={stroke} strokeWidth="2.4" strokeLinecap="round" />
      <path d="M17.1 29 20 22" stroke="#13B58C" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="20" cy="9" r="2.1" fill="#13B58C" />
    </svg>
  );
}

type WordmarkProps = {
  className?: string;
  size?: "sm" | "md" | "lg";
  tone?: "dark" | "light";
  markSize?: number;
};

const sizes = {
  sm: "text-[17px]",
  md: "text-[20px]",
  lg: "text-[24px]"
} as const;

export function Wordmark({ className, size = "md", tone = "dark", markSize }: WordmarkProps) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <AegisMark size={markSize ?? (size === "lg" ? 38 : size === "sm" ? 28 : 32)} tone={tone} />
      <span
        className={cn(
          "font-sans font-semibold leading-none tracking-[-0.045em]",
          sizes[size],
          tone === "dark" ? "text-on-night" : "text-ink-950"
        )}
      >
        aegis<span className="text-mint">pay</span>
      </span>
    </span>
  );
}
