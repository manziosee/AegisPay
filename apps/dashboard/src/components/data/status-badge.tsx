import { cn } from "@/lib/utils";
import { statusLabel } from "@/lib/format";

type Tone = "success" | "warning" | "danger" | "neutral" | "info";

const success = [
  "succeeded",
  "completed",
  "matched",
  "reconciled",
  "delivered",
  "approved",
  "active",
  "resolved",
  "closed",
  "allow",
  "false_positive"
];
const warning = [
  "pending",
  "pending_approval",
  "needs_review",
  "open",
  "matching",
  "retrying",
  "queued",
  "sending",
  "exported_for_manual_entry",
  "submitted_to_bank",
  "review",
  "confirmed",
  "frozen"
];
const danger = ["failed", "rejected", "ignored", "blocked", "block", "exception", "duplicate", "suspended"];
const info = ["prepared", "unmatched", "not_submitted"];

export function toneForStatus(status: string): Tone {
  const value = status.toLowerCase();
  if (success.includes(value)) return "success";
  if (warning.includes(value)) return "warning";
  if (danger.includes(value)) return "danger";
  if (info.includes(value)) return "info";
  return "neutral";
}

const tones: Record<Tone, string> = {
  success: "border-mint/20 bg-mint-soft text-[#0d7a5f]",
  warning: "border-amber/20 bg-amber-soft text-[#8a5a12]",
  danger: "border-coral/20 bg-coral-soft text-[#a83422]",
  neutral: "border-border bg-paper-muted text-ink-500",
  info: "border-primary/15 bg-primary-soft text-[#4436cf]"
};

type StatusBadgeProps = {
  status: string | null | undefined;
  className?: string;
  tone?: Tone;
  label?: string;
  dot?: boolean;
};

export function StatusBadge({ status, className, tone, label, dot = true }: StatusBadgeProps) {
  if (!status) return <span className="text-ink-400">—</span>;
  const resolvedTone = tone ?? toneForStatus(status);
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[11px] font-medium capitalize leading-4",
        tones[resolvedTone],
        className
      )}
    >
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {label ?? statusLabel(status)}
    </span>
  );
}
