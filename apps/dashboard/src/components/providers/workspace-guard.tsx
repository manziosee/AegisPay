"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AegisMark } from "@/components/brand/logo";
import { useSession } from "./session-provider";

export function WorkspaceGuard({ children }: { children: React.ReactNode }) {
  const { status } = useSession();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status === "anonymous") {
      const target = `${pathname}${window.location.search}`;
      router.replace(`/login?next=${encodeURIComponent(target)}`);
    }
  }, [status, router, pathname]);

  if (status === "restoring") {
    return (
      <div className="grid min-h-screen place-items-center bg-paper">
        <div className="flex flex-col items-center gap-3">
          <AegisMark size={44} />
          <p className="text-[12.5px] text-ink-500">Restoring your workspace…</p>
        </div>
      </div>
    );
  }

  if (status !== "authenticated") {
    return <div className="min-h-screen bg-paper" />;
  }

  return <>{children}</>;
}
