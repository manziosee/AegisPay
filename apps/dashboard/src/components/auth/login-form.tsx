"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, CircleAlert, Eye, EyeOff, Fingerprint } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSession } from "@/components/providers/session-provider";
import { errorMessage } from "@/lib/api";

export function safeNext(next?: string) {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/app";
  if (next.startsWith("/login") || next.startsWith("/register")) return "/app";
  return next;
}

export function LoginForm({ next }: { next?: string }) {
  const router = useRouter();
  const { login, verifyMfa } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [mfaToken, setMfaToken] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (mfaToken) {
        await verifyMfa(mfaToken, code);
        router.replace(safeNext(next));
        return;
      }
      const result = await login(email, password);
      if (result.mfaRequired) {
        setMfaToken(result.mfaToken);
        return;
      }
      router.replace(safeNext(next));
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {mfaToken ? (
        <>
          <div className="flex items-start gap-3 rounded-lg border border-border bg-card p-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary">
              <Fingerprint className="size-4" />
            </span>
            <div>
              <p className="text-[12.5px] font-medium text-ink-900">Authenticator required</p>
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-500">
                Enter the 6-digit code from your authenticator app.
              </p>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="mfa-code">Authenticator code</Label>
            <Input
              id="mfa-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
              required
              minLength={6}
              maxLength={6}
              placeholder="000000"
              className="h-10 font-mono text-[15px] tracking-[0.3em]"
              autoFocus
            />
          </div>
          <Button
            type="submit"
            disabled={busy || code.length !== 6}
            className="h-10 w-full bg-primary text-[13px] font-semibold text-primary-foreground"
          >
            {busy ? "Verifying…" : "Verify and sign in"}
            <ArrowRight className="ml-auto size-4" />
          </Button>
          <button
            type="button"
            onClick={() => {
              setMfaToken("");
              setCode("");
              setError("");
            }}
            className="w-full text-center text-[12px] text-ink-500 hover:text-ink-900"
          >
            Back to sign in
          </button>
        </>
      ) : (
        <>
          <div className="space-y-2">
            <Label htmlFor="email">Work email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              placeholder="you@company.com"
              className="h-10"
            />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="password">Password</Label>
            </div>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                placeholder="Your password"
                className="h-10 pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPassword((value) => !value)}
                aria-label={showPassword ? "Hide characters" : "Show characters"}
                className="absolute right-1.5 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded text-ink-400 hover:text-ink-700"
              >
                {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </div>

          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-coral/25 bg-coral-soft px-3 py-2.5 text-[12px] leading-relaxed text-[#a83422]"
            >
              <CircleAlert className="mt-0.5 size-4 shrink-0" />
              {error}
            </div>
          )}

          <Button
            type="submit"
            disabled={busy}
            className="h-10 w-full bg-primary text-[13px] font-semibold text-primary-foreground"
          >
            {busy ? "Signing in…" : "Sign in"}
            <ArrowRight className="ml-auto size-4" />
          </Button>

          <p className="text-center text-[12px] text-ink-500">
            New to AegisPay?{" "}
            <Link href="/register" className="font-medium text-primary hover:text-primary/80">
              Create an account
            </Link>
          </p>
        </>
      )}
    </form>
  );
}
