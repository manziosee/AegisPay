import type { Metadata } from "next";
import { AuthShell } from "@/components/auth/auth-shell";
import { AcceptInvitation } from "@/components/auth/accept-invitation";

export const metadata: Metadata = { title: "Accept invitation" };

export default async function InvitePage({
  searchParams
}: {
  searchParams: Promise<{ invitation?: string; organization?: string; token?: string }>;
}) {
  const { invitation, organization, token } = await searchParams;
  return (
    <AuthShell title="Join a workspace" description="Accept the invitation with the account that uses the invited email address.">
      <AcceptInvitation invitation={invitation ?? ""} organization={organization ?? ""} token={token ?? ""} />
    </AuthShell>
  );
}
