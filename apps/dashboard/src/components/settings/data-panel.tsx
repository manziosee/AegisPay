"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Download, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Panel, PanelHeader } from "@/components/ui-blocks/panel";
import { Field, FormDialog } from "@/components/ui-blocks/form-dialog";
import { Button } from "@/components/ui/button";
import { useSession } from "@/components/providers/session-provider";
import { api, apiBlob, downloadBlob, errorMessage } from "@/lib/api";
import { isAdmin } from "@/lib/roles";

/** Personal and workspace export, and account deletion. */
export function DataPanel() {
  const router = useRouter();
  const { role, logout } = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");

  const download = async (path: string, filename: string) => {
    setBusy(path);
    try {
      downloadBlob(await apiBlob(path), filename);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel className="mt-4">
      <PanelHeader title="Your data" description="Take a copy whenever you like, or close your account" />
      <div className="flex flex-wrap items-center gap-2 p-5">
        <Button variant="outline" className="h-9 text-[12px]" disabled={busy !== null} onClick={() => void download("/auth/account/export", "aegispay-account-export.json")}>
          <Download className="size-3.5" />
          Export my personal data
        </Button>
        {isAdmin(role ?? undefined) && (
          <Button variant="outline" className="h-9 text-[12px]" disabled={busy !== null} onClick={() => void download("/organizations/export", "aegispay-workspace-export.json")}>
            <Download className="size-3.5" />
            Export this workspace
          </Button>
        )}
        <Button variant="outline" className="h-9 border-coral/30 text-[12px] text-coral sm:ml-auto" onClick={() => setDeleting(true)}>
          <Trash2 className="size-3.5" />
          Delete my account
        </Button>
      </div>
      <FormDialog
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete your account"
        description="This can't be undone. Your name, email and sign-in details are removed, and workspaces only you own are closed. Financial and audit records stay, without your name, because businesses must keep them. Export anything you need first."
        destructive
        submitLabel="Delete my account"
        onSubmit={async () => {
          await api("/auth/account/delete", { method: "POST", body: JSON.stringify({ password, code }) });
          await logout();
          toast.success("Your account was deleted.");
          router.push("/");
        }}
      >
        <Field id="delete-password" label="Password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
        <Field id="delete-code" label="Authenticator code (if two-step sign-in is on)" inputMode="numeric" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} />
      </FormDialog>
    </Panel>
  );
}
