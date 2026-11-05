"use client";

import { useState } from "react";
import Link from "next/link";
import { CheckCircle2, CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errorMessage } from "@/lib/api";

function Notice({ tone, children }: { tone: "error" | "success"; children: React.ReactNode }) {
  const Icon = tone === "error" ? CircleAlert : CheckCircle2;
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={
        tone === "error"
          ? "flex items-start gap-2 rounded-lg border border-coral/25 bg-coral-soft px-3 py-2.5 text-[12px] leading-relaxed text-[#a83422]"
          : "flex items-start gap-2 rounded-lg border border-mint/25 bg-mint-soft px-3 py-2.5 text-[12px] leading-relaxed text-[#0d7a5f]"
      }
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

/** Requests a reset email; the response never reveals whether the account exists. */
export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/auth/password/forgot", { method: "POST", anonymous: true, body: JSON.stringify({ email: email.trim() }) });
      setSent(true);
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <div className="space-y-4">
        <Notice tone="success">
          If an account uses {email.trim()}, a reset link is on its way. It works once and expires in one hour. Check your spam folder if it
          doesn&apos;t arrive within a few minutes.
        </Notice>
        <Link href="/login" className="block text-center text-[12.5px] font-medium text-primary hover:underline">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="forgot-email">Account email</Label>
        <Input id="forgot-email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" className="h-10" />
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <Button type="submit" disabled={busy} className="h-10 w-full bg-primary text-[13px] font-semibold text-primary-foreground">
        {busy ? "Sending…" : "Send reset link"}
      </Button>
      <p className="text-center text-[12px] text-ink-500">
        Remembered it?{" "}
        <Link href="/login" className="font-medium text-primary hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}

/** Sets a new password from the emailed one-time token. */
export function ResetPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  if (!token) {
    return (
      <div className="space-y-4">
        <Notice tone="error">This page needs the link from your reset email. Request a new one if it has expired.</Notice>
        <Link href="/forgot-password" className="block text-center text-[12.5px] font-medium text-primary hover:underline">
          Request a new link
        </Link>
      </div>
    );
  }

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    if (password.length < 12) {
      setError("Use at least 12 characters.");
      return;
    }
    if (password !== confirm) {
      setError("The two passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      await api("/auth/password/reset", { method: "POST", anonymous: true, body: JSON.stringify({ token, password }) });
      setDone(true);
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="space-y-4">
        <Notice tone="success">Your password was changed and every device was signed out. Sign in with your new password.</Notice>
        <Link href="/login" className="block text-center text-[12.5px] font-medium text-primary hover:underline">
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="new-password">New password</Label>
        <Input id="new-password" type="password" autoComplete="new-password" required minLength={12} maxLength={72} value={password} onChange={(e) => setPassword(e.target.value)} className="h-10" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="confirm-password">Repeat new password</Label>
        <Input id="confirm-password" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} className="h-10" />
      </div>
      {error && (
        <Notice tone="error">
          {error}{" "}
          {error.includes("expired") && (
            <Link href="/forgot-password" className="font-medium underline">
              Request a new link
            </Link>
          )}
        </Notice>
      )}
      <Button type="submit" disabled={busy} className="h-10 w-full bg-primary text-[13px] font-semibold text-primary-foreground">
        {busy ? "Saving…" : "Change password"}
      </Button>
    </form>
  );
}
