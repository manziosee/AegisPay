import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { StatusBadge } from "@/components/data/status-badge";
import { formatMinor } from "@/lib/format";
import { SAMPLE_EVENTS, SAMPLE_TRANSACTION } from "@/lib/sample-data";
import { cn } from "@/lib/utils";

type SampleRecordProps = {
  className?: string;
  compact?: boolean;
};

export function SampleRecord({ className, compact = false }: SampleRecordProps) {
  const events = SAMPLE_EVENTS.filter((event) =>
    ["created", "risk", "reconciled"].includes(event.id)
  );

  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-card p-4 text-ink-950 shadow-lift",
        className
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-400">
          Sample record
        </span>
        <StatusBadge status={SAMPLE_TRANSACTION.status} />
      </div>
      <div className="mt-3 flex items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[11px] text-ink-500">{SAMPLE_TRANSACTION.reference}</p>
          <p className="mt-1 text-[26px] font-semibold leading-none tracking-[-0.03em]">
            {formatMinor(SAMPLE_TRANSACTION.amount_minor, SAMPLE_TRANSACTION.currency)}
          </p>
        </div>
        <span className="rounded-md border border-border bg-paper-muted px-2 py-1 font-mono text-[10px] text-ink-500">
          Collection
        </span>
      </div>

      {!compact && (
        <ul className="mt-4 space-y-2 border-t border-border pt-3">
          {events.map((event) => (
            <li key={event.id} className="flex items-center gap-2.5 text-[11.5px]">
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  event.id === "risk" ? "bg-amber-bright" : "bg-mint"
                )}
              />
              <span className="flex-1 text-ink-700">{event.label}</span>
              <span className="font-mono text-[10px] text-ink-400">{event.timestamp}</span>
            </li>
          ))}
        </ul>
      )}

      <Link
        href="/#transaction"
        className="mt-3 inline-flex items-center gap-1 text-[11.5px] font-medium text-primary hover:text-primary/80"
      >
        See the full trail
        <ArrowUpRight className="size-3.5" />
      </Link>
    </div>
  );
}
