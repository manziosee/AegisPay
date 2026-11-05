"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/components/providers/session-provider";
import { api, errorMessage } from "@/lib/api";

/** Accepts an emailed invitation, asking the visitor to sign in first if needed. */
export function AcceptInvitation({ invitation, organization, token }: { invitation: string; organization: string; token: string }) {
  const router = useRouter();
  const { status, fullName, switchOrganization } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!invitation || !organization || !token.startsWith("aegis_invite_")) {
    return (
      <p role="alert" className="flex items-start gap-2 rounded-lg border border-coral/25 bg-coral-soft px-3 py-2.5 text-[12px] text-[#a83422]">
        <CircleAlert className="mt-0.5 size-4 shrink-0" />
        This invitation link is incomplete. Open the link from your invitation email again, or ask for a new invitation.
      </p>
    );
  }

  const here = `/invite?${new URLSearchParams({ invitation, organization, token }).toString()}`;

  if (status === "restoring") {
    return <p className="text-[13px] text-ink-500">Checking your session…</p>;
  }

  if (status !== "authenticated") {
    return (
      <div className="space-y-3">
        <p className="text-[13px] leading-relaxed text-ink-600">
          Sign in, or create a free account, using the email address the invitation was sent to. You&apos;ll come back here to accept it.
        </p>
        <Button asChild className="h-10 w-full bg-primary text-[13px] font-semibold text-primary-foreground">
          <Link href={`/login?next=${encodeURIComponent(here)}`}>Sign in to accept</Link>
        </Button>
        <Button asChild variant="outline" className="h-10 w-full text-[13px]">
          <Link href={`/register?next=${encodeURIComponent(here)}`}>Create an account</Link>
        </Button>
      </div>
    );
  }

  const accept = async () => {
    setBusy(true);
    setError("");
    try {
      await api(`/invitations/${encodeURIComponent(invitation)}/accept`, {
        method: "POST",
        headers: { "X-Organization-ID": organization },
        body: JSON.stringify({ invite_token: token })
      });
      await switchOrganization(organization);
      router.push("/app");
    } catch (acceptError) {
      setError(errorMessage(acceptError));
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-relaxed text-ink-600">
        You&apos;re signed in{fullName ? ` as ${fullName}` : ""}. Accepting adds this workspace to your workspace switcher.
      </p>
      {error && (
        <p role="alert" className="flex items-start gap-2 rounded-lg border border-coral/25 bg-coral-soft px-3 py-2.5 text-[12px] text-[#a83422]">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          {error.includes("belongs to another account") || error.includes("invalid")
            ? "This invitation is for a different email address, has expired, or was already used. Sign in with the invited email, or ask for a new invitation."
            : error}
        </p>
      )}
      <Button disabled={busy} onClick={() => void accept()} className="h-10 w-full bg-primary text-[13px] font-semibold text-primary-foreground">
        {busy ? "Accepting…" : "Accept invitation"}
      </Button>
    </div>
  );
}
