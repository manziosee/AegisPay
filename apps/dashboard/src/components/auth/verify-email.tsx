"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { api, errorMessage } from "@/lib/api";

/** Confirmation needs a click, so email scanners that open links don't use the token. */
export function VerifyEmail({ token }: { token: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState("");

  if (!token) {
    return <p role="alert" className="text-[13px] text-ink-600">Open the link from your confirmation email. You can request a new one after signing in.</p>;
  }
  if (state === "done") {
    return (
      <div className="space-y-4">
        <p role="status" className="rounded-lg border border-mint/25 bg-mint-soft px-3 py-2.5 text-[13px] text-[#0d7a5f]">Your email is confirmed.</p>
        <Button asChild className="h-10 w-full bg-primary text-[13px] font-semibold text-primary-foreground">
          <Link href="/app">Open AegisPay</Link>
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {error && <p role="alert" className="rounded-lg border border-coral/25 bg-coral-soft px-3 py-2.5 text-[12px] text-[#a83422]">{error}</p>}
      <Button
        disabled={state === "busy"}
        className="h-10 w-full bg-primary text-[13px] font-semibold text-primary-foreground"
        onClick={async () => {
          setState("busy");
          setError("");
          try {
            await api("/auth/email/verify", { method: "POST", anonymous: true, body: JSON.stringify({ token }) });
            setState("done");
          } catch (verifyError) {
            setError(errorMessage(verifyError));
            setState("idle");
          }
        }}
      >
        {state === "busy" ? "Confirming…" : "Confirm my email"}
      </Button>
    </div>
  );
}
