import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Wordmark } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="grid min-h-screen place-items-center bg-night px-5 text-on-night">
      <div className="w-full max-w-[440px]">
        <Wordmark size="md" />
        <p className="mt-10 font-mono text-[11px] uppercase tracking-[0.12em] text-on-night-muted">
          404
        </p>
        <h1 className="mt-2 font-display text-[42px] leading-[1.05] tracking-[-0.03em]">
          This page is not part of the record.
        </h1>
        <p className="mt-3 text-[13.5px] leading-relaxed text-on-night-muted">
          The address does not match a page in this sandbox workspace.
        </p>
        <div className="mt-7 flex flex-wrap gap-3">
          <Button asChild className="h-10 bg-primary px-4 text-[13px] font-semibold text-primary-foreground">
            <Link href="/">
              Back to AegisPay
              <ArrowRight className="size-4" />
            </Link>
          </Button>
          <Button
            asChild
            variant="outline"
            className="h-10 border-white/15 bg-transparent px-4 text-[13px] text-on-night hover:bg-white/8 hover:text-on-night"
          >
            <Link href="/app">Open workspace</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
