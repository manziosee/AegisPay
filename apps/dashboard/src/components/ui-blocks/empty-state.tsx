import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function EmptyState({
  icon: Icon,
  title,
  text,
  action,
  className
}: {
  icon: LucideIcon;
  title: string;
  text: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-14 text-center", className)}>
      <span className="grid size-11 place-items-center rounded-xl border border-border bg-paper-muted text-ink-400">
        <Icon className="size-5" strokeWidth={1.7} />
      </span>
      <p className="mt-3 text-[13.5px] font-medium text-ink-900">{title}</p>
      <p className="mt-1 max-w-[340px] text-[12px] leading-relaxed text-ink-400">{text}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
