import type { Metadata } from "next";
import { AuthShell } from "@/components/auth/auth-shell";
import { RegisterForm } from "@/components/auth/register-form";

export const metadata: Metadata = {
  title: "Create your workspace"
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
      description="Start in a free practice workspace with simulated money. Create a live workspace whenever you're ready."
    >
      <RegisterForm next={next} />
    </AuthShell>
  );
}
