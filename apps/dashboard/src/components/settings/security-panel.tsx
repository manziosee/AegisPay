"use client";

import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Panel, PanelHeader } from "@/components/ui-blocks/panel";
import { Field, FormDialog } from "@/components/ui-blocks/form-dialog";
import { Button } from "@/components/ui/button";
import { api, errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import type { MfaEnrollment, MfaStatus } from "@/lib/types";

/** Authenticator-app (TOTP) MFA for the signed-in user. */
export function SecurityPanel() {
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [error, setError] = useState("");
  const [enrollment, setEnrollment] = useState<MfaEnrollment | null>(null);
  const [qr, setQr] = useState("");
  const [code, setCode] = useState("");
  const [disableOpen, setDisableOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await api<MfaStatus>("/auth/mfa/status"));
    } catch (loadError) {
      setError(errorMessage(loadError));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const start = async () => {
    setStarting(true);
    try {
      const result = await api<MfaEnrollment>("/auth/mfa/enroll", { method: "POST" });
      setQr(await QRCode.toDataURL(result.otpauth_uri, { margin: 1, width: 200 }));
      setCode("");
      setEnrollment(result);
    } catch (startError) {
      toast.error(errorMessage(startError));
    } finally {
      setStarting(false);
    }
  };

  const verify = async () => {
    if (!/^\d{6}$/.test(code)) throw new Error("Enter the six-digit code from your authenticator app.");
    await api("/auth/mfa/verify", { method: "POST", body: JSON.stringify({ code }) });
    toast.success("Two-step sign-in is on. You will be asked for a code at each sign-in.");
    setEnrollment(null);
    await load();
  };

  const disable = async () => {
    if (!/^\d{6}$/.test(code)) throw new Error("Enter the six-digit code from your authenticator app.");
    await api("/auth/mfa/disable", { method: "POST", body: JSON.stringify({ code, password }) });
    toast.success("Two-step sign-in is off.");
    setPassword("");
    await load();
  };

  return (
    <Panel className="mt-4">
      <PanelHeader title="Your sign-in security" description="Applies to your user account in every workspace" />
      <div className="flex flex-wrap items-center gap-4 p-5">
        <span className="grid size-10 place-items-center rounded-lg bg-primary-soft text-primary">
          <ShieldCheck className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-ink-900">Two-step sign-in (authenticator app)</p>
          <p className="text-[11.5px] text-ink-500">
            {error
              ? error
              : status === null
                ? "Checking…"
                : status.enabled
                  ? `On since ${formatDate(status.enabled_at)}. Sign-in needs your password and a code.`
                  : "Off. Add a code from an authenticator app (Google Authenticator, 1Password, Authy, Microsoft Authenticator) to every sign-in."}
          </p>
        </div>
        {status?.enabled ? (
          <Button
            variant="outline"
            className="h-9 border-coral/30 text-[12px] text-coral"
            onClick={() => {
              setCode("");
              setPassword("");
              setDisableOpen(true);
            }}
          >
            Turn off
          </Button>
        ) : (
          <Button className="h-9 bg-primary text-[12px] font-semibold text-primary-foreground" disabled={starting || status === null} onClick={() => void start()}>
            {starting ? "Preparing…" : "Turn on"}
          </Button>
        )}
      </div>

      <FormDialog
        open={enrollment !== null}
        onOpenChange={(next) => !next && setEnrollment(null)}
        title="Set up your authenticator app"
        description="Scan the code, or enter the key by hand, then type the six-digit code the app shows."
        submitLabel="Verify and turn on"
        onSubmit={verify}
      >
        {qr && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={qr} alt="QR code for your authenticator app" width={200} height={200} className="mx-auto rounded-md border border-border" />
        )}
        <div className="rounded-md border border-border bg-paper-muted p-2 text-center">
          <p className="text-[10.5px] text-ink-400">Setup key</p>
          <code className="break-all font-mono text-[12px] tracking-wider">{enrollment?.secret}</code>
        </div>
        <Field id="mfa-code" label="Six-digit code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} />
      </FormDialog>

      <FormDialog
        open={disableOpen}
        onOpenChange={setDisableOpen}
        title="Turn off two-step sign-in"
        description="Confirm with your password and a current code."
        destructive
        submitLabel="Turn off"
        onSubmit={disable}
      >
        <Field id="mfa-password" label="Password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
        <Field id="mfa-disable-code" label="Six-digit code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} />
      </FormDialog>
    </Panel>
  );
}
