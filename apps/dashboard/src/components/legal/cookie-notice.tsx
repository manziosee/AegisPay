"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

const KEY = "aegispay.cookie-notice";

/** A notice rather than a consent prompt: only a strictly necessary cookie is used. */
export function CookieNotice() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      setVisible(!localStorage.getItem(KEY));
    } catch {
      setVisible(false);
    }
  }, []);

  if (!visible) return null;
  return (
    <div role="region" aria-label="Cookie notice" className="fixed inset-x-3 bottom-3 z-50 mx-auto flex max-w-[560px] flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-3 text-[12px] text-ink-700 shadow-lift">
      <p className="min-w-0 flex-1">
        We only use a cookie that keeps you signed in, with no tracking.{" "}
        <Link href="/cookies" className="font-medium text-primary hover:underline">
          Learn more
        </Link>
      </p>
      <Button
        size="sm"
        variant="outline"
        className="h-7 text-[11.5px]"
        onClick={() => {
          try {
            localStorage.setItem(KEY, "dismissed");
          } catch {
            // Without storage the notice simply returns next visit.
          }
          setVisible(false);
        }}
      >
        Got it
      </Button>
    </div>
  );
}
