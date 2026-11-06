"use client";

import { useEffect, useState } from "react";
import { MailWarning } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api, errorMessage } from "@/lib/api";
import type { Principal } from "@/lib/types";

/** Reminds unconfirmed users, and resends the confirmation email. */
export function EmailBanner() {
  const [address, setAddress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    api<Principal>("/auth/me", { anonymous: true })
      .then((me) => {
        if (active && me.email_verified === false) setAddress(me.email ?? "your address");
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  if (!address) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-amber/20 bg-amber-soft/70 px-4 py-2 text-[11.5px] text-[#8a5a12] sm:px-6">
      <MailWarning className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">Confirm {address} to create live workspaces and send invitation emails. Check your inbox and spam folder.</span>
      <Button
        size="sm"
        variant="outline"
        className="h-7 text-[11px]"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await api("/auth/email/resend", { method: "POST" });
            toast.success("Confirmation email sent.");
          } catch (error) {
            toast.error(errorMessage(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        Resend email
      </Button>
    </div>
  );
}
