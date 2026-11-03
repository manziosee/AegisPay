import { cn } from "@/lib/utils";

export function Panel({
  className,
  children,
  ...props
}: React.ComponentProps<"section">) {
  return (
    <section
      className={cn(
        "overflow-hidden rounded-xl border border-border bg-card shadow-panel",
        className
      )}
      {...props}
    >
      {children}
    </section>
  );
}

export function PanelHeader({
  title,
  description,
  action,
  className,
  children
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4",
        className
      )}
    >
      <div className="min-w-0">
        <h2 className="text-[14px] font-semibold tracking-[-0.01em] text-ink-950">{title}</h2>
        {description && <p className="mt-0.5 text-[12px] text-ink-400">{description}</p>}
        {children}
      </div>
      {action}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  meta
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  meta?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.035em] text-ink-950">
          {title}
        </h1>
        {description && (
          <p className="mt-1.5 max-w-[640px] text-[13px] leading-relaxed text-ink-500">
            {description}
          </p>
        )}
        {meta && <div className="mt-3">{meta}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function FieldError({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="text-[11.5px] leading-relaxed text-destructive">
      {children}
    </p>
  );
}
