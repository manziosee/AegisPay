"use client";

import { useEffect, useMemo, useState } from "react";
import { browserCountry } from "@/lib/locale";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, CircleAlert, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSession } from "@/components/providers/session-provider";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { safeNext } from "./login-form";

type WorkspaceType = "business" | "personal";

export function RegisterForm({ next }: { next?: string }) {
  const router = useRouter();
  const { register } = useSession();
  const [workspaceType, setWorkspaceType] = useState<WorkspaceType>("business");
  const [fullName, setFullName] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [country, setCountry] = useState("");
  useEffect(() => {
    setCountry((current) => current || browserCountry());
  }, []);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const strength = useMemo(() => {
    let score = 0;
    if (password.length >= 12) score += 1;
    if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
    if (/\d/.test(password)) score += 1;
    if (/[^a-zA-Z0-9]/.test(password)) score += 1;
    return score;
  }, [password]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    if (password.length < 12) {
      setError("Use at least 12 characters for the password.");
      return;
    }
    setBusy(true);
    try {
      await register({
        full_name: fullName,
        email,
        password,
        workspace_type: workspaceType,
        organization_name: organizationName,
        country_code: country.trim().toUpperCase()
      });
      router.replace(safeNext(next));
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div className="space-y-2">
        <Label htmlFor="full-name">Full name</Label>
        <Input
          id="full-name"
          autoComplete="name"
          value={fullName}
          onChange={(event) => setFullName(event.target.value)}
          required
          placeholder="Amina Reese"
          className="h-10"
        />
      </div>

      <div className="space-y-2">
        <Label>Workspace type</Label>
        <div
          role="radiogroup"
          aria-label="Workspace type"
          className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-paper-muted p-1"
        >
          {(["business", "personal"] as WorkspaceType[]).map((type) => (
            <button
              key={type}
              type="button"
              role="radio"
              aria-checked={workspaceType === type}
              onClick={() => setWorkspaceType(type)}
              className={cn(
                "h-8 rounded-md text-[12.5px] capitalize transition-colors",
                workspaceType === type
                  ? "bg-card font-medium text-ink-950 shadow-panel"
                  : "text-ink-500 hover:text-ink-900"
              )}
            >
              {type}
            </button>
          ))}
        </div>
      </div>

      {workspaceType === "business" && (
        <div className="space-y-2">
          <Label htmlFor="organization-name">Organization name</Label>
          <Input
            id="organization-name"
            value={organizationName}
            onChange={(event) => setOrganizationName(event.target.value)}
            required
            placeholder="Northwind Trading"
            className="h-10"
          />
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="register-country">Country (two-letter code)</Label>
        <Input
          id="register-country"
          value={country}
          onChange={(event) => setCountry(event.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2))}
          required
          minLength={2}
          maxLength={2}
          placeholder="US"
          autoComplete="country"
          className="h-10 font-mono"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="register-email">Work email</Label>
        <Input
          id="register-email"
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
        <Label htmlFor="register-password">Password</Label>
        <div className="relative">
          <Input
            id="register-password"
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            minLength={12}
            placeholder="At least 12 characters"
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
        <div className="flex items-center gap-2">
          <div className="flex flex-1 gap-1" aria-hidden="true">
            {[0, 1, 2, 3].map((index) => (
              <span
                key={index}
                className={cn(
                  "h-1 flex-1 rounded-full",
                  strength > index ? "bg-mint" : "bg-border"
                )}
              />
            ))}
          </div>
          <span className="text-[10.5px] text-ink-400">
            {password.length === 0
              ? "12+ characters"
              : strength <= 1
                ? "Weak"
                : strength === 2
                  ? "Fair"
                  : strength === 3
                    ? "Good"
                    : "Strong"}
          </span>
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
        {busy ? "Creating workspace…" : "Create account"}
        <ArrowRight className="ml-auto size-4" />
      </Button>

      <p className="text-center text-[12px] text-ink-500">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-primary hover:text-primary/80">
          Sign in
        </Link>
      </p>
    </form>
  );
}
