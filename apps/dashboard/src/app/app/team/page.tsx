"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, UserPlus, Users } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, Panel, PanelHeader } from "@/components/ui-blocks/panel";
import { EmptyState } from "@/components/ui-blocks/empty-state";
import { StatusBadge } from "@/components/data/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog";
import { useSession } from "@/components/providers/session-provider";
import { api, errorMessage } from "@/lib/api";
import { formatDate, formatDateTime, roleLabel } from "@/lib/format";
import { isAdmin } from "@/lib/roles";
import type { Invitation, Member, Page } from "@/lib/types";

const roles = ["admin", "finance_operator", "fraud_analyst", "developer", "auditor"];

export default function TeamPage() {
  const { session, role } = useSession();
  const allowed = isAdmin(role ?? "");
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteForm, setInviteForm] = useState({ email: "", role: "finance_operator" });
  const [inviteToken, setInviteToken] = useState("");
  const [busy, setBusy] = useState("");
  const [suspendTarget, setSuspendTarget] = useState<Member | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    if (!session || !allowed) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [memberResult, invitationPage] = await Promise.all([
        api<{ data: Member[] }>("/members"),
        api<Page<Invitation>>("/invitations?limit=100")
      ]);
      setMembers(memberResult.data ?? []);
      setInvitations(invitationPage.data ?? []);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [allowed, session]);

  useEffect(() => {
    void load();
  }, [load]);

  const invite = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!session) return;
    setBusy("invite");
    try {
      const result = await api<{ invite_token: string; email: string }>(
        "/invitations",
        { method: "POST", body: JSON.stringify(inviteForm) }
      );
      setInviteToken(result.invite_token);
      setInviteForm({ email: "", role: "finance_operator" });
      toast.success(`Invitation created for ${result.email}.`);
      await load();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy("");
    }
  };

  const suspend = async (member: Member) => {
    if (!session) return;
    setBusy(member.membership_id);
    try {
      await api(`/members/${encodeURIComponent(member.membership_id)}`, {
        method: "DELETE"
      });
      toast.success(`Access suspended for ${member.email}.`);
      setSuspendTarget(null);
      await load();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy("");
    }
  };

  const copyToken = async () => {
    try {
      await navigator.clipboard.writeText(inviteToken);
      setCopied(true);
      toast.success("Invitation token copied.");
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("Clipboard access is unavailable.");
    }
  };

  if (!allowed) {
    return (
      <Panel>
        <EmptyState
          icon={Users}
          title="Team access is restricted"
          text="Only workspace owners and admins can manage members and invitations."
        />
      </Panel>
    );
  }

  return (
    <div>
      <PageHeader
        title="Team access"
        description="Invite colleagues, review membership and suspend access when roles change."
      />

      <Panel className="mb-4">
        <PanelHeader
          title="Invite a teammate"
          description="Invitation tokens are shown once. Deliver them through a trusted channel."
        />
        <form onSubmit={invite} className="space-y-3 p-5">
          <div className="grid gap-3 sm:grid-cols-[1.4fr_0.8fr_auto] sm:items-end">
            <div className="space-y-2">
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                type="email"
                value={inviteForm.email}
                onChange={(event) => setInviteForm({ ...inviteForm, email: event.target.value })}
                required
                placeholder="colleague@company.com"
                className="h-9 text-[12px]"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-role">Role</Label>
              <Select
                value={inviteForm.role}
                onValueChange={(value) => setInviteForm({ ...inviteForm, role: value })}
              >
                <SelectTrigger id="invite-role" className="h-9 text-[12px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((item) => (
                    <SelectItem key={item} value={item} className="capitalize">
                      {roleLabel(item)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              type="submit"
              disabled={busy === "invite"}
              className="h-9 bg-primary text-[12px] font-semibold text-primary-foreground"
            >
              <UserPlus className="size-3.5" />
              {busy === "invite" ? "Creating…" : "Create invitation"}
            </Button>
          </div>
          <p className="text-[10.5px] text-ink-400">Invitation delivery is manual in this sandbox.</p>
        </form>

        {inviteToken && (
          <div className="mx-5 mb-5 rounded-lg border border-amber/25 bg-amber-soft/60 p-3">
            <p className="text-[11px] font-medium text-[#7a5210]">One-time invitation token</p>
            <div className="mt-2 flex items-start gap-2">
              <code className="min-w-0 flex-1 break-all rounded border border-amber/20 bg-card px-2 py-1.5 font-mono text-[11px] text-ink-800">
                {inviteToken}
              </code>
              <Button variant="outline" size="sm" className="h-8 shrink-0 text-[11px]" onClick={() => void copyToken()}>
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <p className="mt-2 text-[10.5px] text-[#7a5210]">
              Copy it now and share it securely. It cannot be retrieved again.
            </p>
          </div>
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader
            title="Workspace members"
            description={`${members.length} membership${members.length === 1 ? "" : "s"}`}
          />
          {loading ? (
            <div className="space-y-2 p-5">
              {[0, 1, 2].map((index) => (
                <div key={index} className="h-11 animate-pulse rounded-md bg-paper-muted" />
              ))}
            </div>
          ) : members.length === 0 ? (
            <EmptyState icon={Users} title="No members found" text="Members appear after registration." />
          ) : (
            <ul className="divide-y divide-border">
              {members.map((member) => (
                <li key={member.membership_id} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-[12px] font-medium text-ink-900">{member.full_name}</p>
                    <p className="truncate text-[10.5px] text-ink-400">{member.email}</p>
                    <p className="mt-0.5 text-[10px] capitalize text-ink-400">
                      {roleLabel(member.role)} · joined {formatDate(member.joined_at)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <StatusBadge status={member.status} />
                    {member.role !== "owner" && member.status === "active" && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-[10.5px]"
                        disabled={busy === member.membership_id}
                        onClick={() => setSuspendTarget(member)}
                      >
                        Suspend
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel>
          <PanelHeader
            title="Invitations"
            description={`${invitations.length} invitation${invitations.length === 1 ? "" : "s"}`}
          />
          {invitations.length === 0 ? (
            <EmptyState
              icon={UserPlus}
              title="No invitations found"
              text="Create an invitation to add a teammate."
            />
          ) : (
            <ul className="divide-y divide-border">
              {invitations.map((item) => (
                <li key={item.id} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-[12px] font-medium text-ink-900">{item.email}</p>
                    <p className="mt-0.5 text-[10.5px] capitalize text-ink-400">
                      {roleLabel(item.role)} · expires {formatDate(item.expires_at)}
                    </p>
                  </div>
                  <StatusBadge
                    status={item.accepted_at ? "accepted" : "pending"}
                    label={item.accepted_at ? "accepted" : "pending"}
                    tone={item.accepted_at ? "success" : "warning"}
                  />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <AlertDialog
        open={Boolean(suspendTarget)}
        onOpenChange={(open) => !open && setSuspendTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Suspend workspace access?</AlertDialogTitle>
            <AlertDialogDescription>
              {suspendTarget
                ? `${suspendTarget.email} will no longer be able to use this workspace. Existing audit records are unchanged.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => suspendTarget && void suspend(suspendTarget)}
            >
              Suspend access
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
