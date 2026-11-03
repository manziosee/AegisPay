import type { Metadata } from "next";
import { AuthShell } from "@/components/auth/auth-shell";
import { RegisterForm } from "@/components/auth/register-form";

export const metadata: Metadata = {
  title: "Create a sandbox workspace"
};

export default async function RegisterPage({
  searchParams
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <AuthShell
      title="Create your workspace"
      description="Set up a sandbox organization for ledger, approval and reconciliation workflows."
    >
      <RegisterForm next={next} />
    </AuthShell>
  );
}
