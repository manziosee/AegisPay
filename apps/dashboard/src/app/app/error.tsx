"use client";

import { CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui-blocks/panel";

export default function WorkspaceError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <Panel className="mx-auto max-w-[560px]">
      <div className="flex flex-col items-center px-6 py-12 text-center">
        <span className="grid size-11 place-items-center rounded-xl border border-coral/20 bg-coral-soft text-coral">
          <CircleAlert className="size-5" />
        </span>
        <h1 className="mt-3 text-[15px] font-semibold text-ink-950">
          This workspace view could not be rendered
        </h1>
        <p className="mt-1 max-w-[380px] text-[12px] leading-relaxed text-ink-500">
          The rest of the workspace is unaffected. Retry the view or return to the overview.
        </p>
        {error.digest && (
          <p className="mt-2 font-mono text-[10px] text-ink-300">digest {error.digest}</p>
        )}
        <div className="mt-5 flex gap-2">
          <Button className="h-9 bg-primary text-[12px] font-semibold text-primary-foreground" onClick={reset}>
            Retry view
          </Button>
          <Button asChild variant="outline" className="h-9 text-[12px]">
            <a href="/app">Back to overview</a>
          </Button>
        </div>
      </div>
    </Panel>
  );
}
