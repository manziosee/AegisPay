"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  Copy,
  Eye,
  MoreHorizontal,
  Pencil,
  UserCheck,
  UserMinus,
  UserPlus,
  Users,
  X
} from "lucide-react";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle
} from "@/components/ui/sheet";
import { useSession } from "@/components/providers/session-provider";
import { api, errorMessage } from "@/lib/api";
import { formatDate, formatDateTime, roleLabel } from "@/lib/format";
import { isAdmin } from "@/lib/roles";
import type { Invitation, Member, Page, Role } from "@/lib/types";

const roles = ["admin", "finance_operator", "fraud_analyst", "developer", "auditor"];

function invitationState(invitation: Invitation) {
  if (invitation.accepted_at) return "accepted";
  if (new Date(invitation.expires_at).getTime() < Date.now()) return "expired";
  return "pending";
}

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
  const [revokeTarget, setRevokeTarget] = useState<Invitation | null>(null);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [editingMember, setEditingMember] = useState<Member | null>(null);
  const [roleDraft, setRoleDraft] = useState<Role>("finance_operator");
  const [roleError, setRoleError] = useState("");
  const [savingRole, setSavingRole] = useState(false);
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

  const viewing = useMemo(
    () => members.find((member) => member.membership_id === viewingId) ?? null,
    [members, viewingId]
  );

  const canEditRole = (member: Member) =>
    member.role !== "owner" && (member.role !== "admin" || role === "owner");

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

  const openRoleEdit = (member: Member) => {
    setRoleDraft(member.role === "owner" || member.role === "admin" ? "admin" : member.role);
    setRoleError("");
    setEditingMember(member);
  };

  const saveRole = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!session || !editingMember) return;
    setSavingRole(true);
    setRoleError("");
    try {
      await api(`/members/${encodeURIComponent(editingMember.membership_id)}`, {
        method: "PATCH",
        body: JSON.stringify({ role: roleDraft })
      });
      toast.success("Role updated.");
      setEditingMember(null);
      await load();
    } catch (error) {
      setRoleError(errorMessage(error));
    } finally {
      setSavingRole(false);
    }
  };

  const setStatus = async (member: Member, status: "active" | "suspended") => {
    if (!session) return;
    setBusy(member.membership_id);
    try {
      await api(`/members/${encodeURIComponent(member.membership_id)}`, {
        method: "PATCH",
        body: JSON.stringify({ status })
      });
      toast.success(
        status === "active"
          ? `${member.email} can access the workspace again.`
          : `Access suspended for ${member.email}.`
      );
      setSuspendTarget(null);
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
      if (viewingId === member.membership_id) setViewingId(null);
      await load();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy("");
    }
  };

  const revokeInvitation = async (invitation: Invitation) => {
    if (!session) return;
    setBusy(invitation.id);
    try {
      await api(`/invitations/${encodeURIComponent(invitation.id)}`, {
        method: "DELETE"
      });
      toast.success("Invitation revoked.");
      setRevokeTarget(null);
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
        description="Invite colleagues, review membership and change roles or access without deleting their audit history."
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
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => setViewingId(member.membership_id)}
                  >
                    <p className="truncate text-[12px] font-medium text-ink-900">{member.full_name}</p>
                    <p className="truncate text-[10.5px] text-ink-400">{member.email}</p>
                    <p className="mt-0.5 text-[10px] text-ink-400">
                      {roleLabel(member.role)} · joined {formatDate(member.joined_at)}
                    </p>
                  </button>
                  <div className="flex shrink-0 items-center gap-2">
                    <StatusBadge status={member.status} />
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Actions for ${member.email}`}
                        >
                          <MoreHorizontal className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-44">
                        <DropdownMenuItem onSelect={() => setViewingId(member.membership_id)}>
                          <Eye className="size-3.5" />
                          View member
                        </DropdownMenuItem>
                        {canEditRole(member) && (
                          <DropdownMenuItem onSelect={() => openRoleEdit(member)}>
                            <Pencil className="size-3.5" />
                            Edit role
                          </DropdownMenuItem>
                        )}
                        {member.role !== "owner" && (
                          <>
                            <DropdownMenuSeparator />
                            {member.status === "active" ? (
                              <DropdownMenuItem
                                variant="destructive"
                                onSelect={() => setSuspendTarget(member)}
                              >
                                <UserMinus className="size-3.5" />
                                Suspend access
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem
                                onSelect={() => void setStatus(member, "active")}
                                disabled={busy === member.membership_id}
                              >
                                <UserCheck className="size-3.5" />
                                Reactivate access
                              </DropdownMenuItem>
                            )}
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
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
              {invitations.map((item) => {
                const state = invitationState(item);
                const revoked = state !== "accepted";
                return (
                  <li key={item.id} className="flex items-center justify-between gap-3 px-5 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-[12px] font-medium text-ink-900">{item.email}</p>
                      <p className="mt-0.5 text-[10.5px] text-ink-400">
                        {roleLabel(item.role)} · expires {formatDate(item.expires_at)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <StatusBadge
                        status={state}
                        label={state}
                        tone={
                          state === "accepted"
                            ? "success"
                            : state === "expired"
                              ? "neutral"
                              : "warning"
                        }
                      />
                      {revoked && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Revoke invitation for ${item.email}`}
                          disabled={busy === item.id}
                          onClick={() => setRevokeTarget(item)}
                        >
                          <X className="size-3.5" />
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>

      <Sheet open={Boolean(viewing)} onOpenChange={(open) => !open && setViewingId(null)}>
        <SheetContent className="w-full overflow-y-auto border-border bg-paper p-0 sm:max-w-[480px]">
          {viewing && (
            <>
              <SheetHeader className="border-b border-border bg-card px-5 py-4">
                <div className="flex items-center gap-2">
                  <StatusBadge status={viewing.status} />
                  <span className="font-mono text-[10.5px] text-ink-400">
                    {viewing.membership_id}
                  </span>
                </div>
                <SheetTitle className="mt-1 text-[16px] text-ink-950">
                  {viewing.full_name}
                </SheetTitle>
                <SheetDescription className="break-all text-[11px] text-ink-400">
                  {viewing.email}
                </SheetDescription>
              </SheetHeader>
              <div className="space-y-5 p-5">
                <dl className="divide-y divide-border rounded-lg border border-border bg-card">
                  {[
                    ["Role", roleLabel(viewing.role)],
                    ["Status", viewing.status],
                    ["User ID", viewing.user_id],
                    ["Membership ID", viewing.membership_id],
                    ["Joined", formatDateTime(viewing.joined_at)]
                  ].map(([label, value]) => (
                    <div key={label} className="px-4 py-3">
                      <dt className="text-[10.5px] text-ink-400">{label}</dt>
                      <dd className="mt-0.5 break-all font-mono text-[11px] text-ink-800">
                        {value}
                      </dd>
                    </div>
                  ))}
                </dl>
                <p className="text-[10.5px] leading-relaxed text-ink-400">
                  Suspending access preserves this membership and its audit history. Reactivating
                  restores access to the same workspace.
                </p>
              </div>
              <SheetFooter className="border-t border-border bg-card px-5 py-4">
                <div className="grid gap-2">
                  {canEditRole(viewing) && (
                    <Button
                      variant="outline"
                      className="h-9 text-[12px]"
                      onClick={() => {
                        openRoleEdit(viewing);
                        setViewingId(null);
                      }}
                    >
                      <Pencil className="size-3.5" />
                      Edit role
                    </Button>
                  )}
                  {viewing.role !== "owner" &&
                    (viewing.status === "active" ? (
                      <Button
                        variant="outline"
                        className="h-9 border-coral/30 text-[12px] text-coral hover:bg-coral-soft"
                        onClick={() => {
                          setSuspendTarget(viewing);
                          setViewingId(null);
                        }}
                      >
                        <UserMinus className="size-3.5" />
                        Suspend access
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        className="h-9 text-[12px]"
                        disabled={busy === viewing.membership_id}
                        onClick={() => void setStatus(viewing, "active")}
                      >
                        <UserCheck className="size-3.5" />
                        Reactivate access
                      </Button>
                    ))}
                </div>
              </SheetFooter>
            </>
          )}
        </SheetContent>
      </Sheet>

      <Dialog open={Boolean(editingMember)} onOpenChange={(open) => !open && setEditingMember(null)}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle className="text-[16px]">Edit member role</DialogTitle>
            <DialogDescription className="text-[12px]">
              {editingMember
                ? `${editingMember.full_name} (${editingMember.email}) keeps their existing access until this role is saved.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={saveRole} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="member-role">Role</Label>
              <select
                id="member-role"
                value={roleDraft}
                onChange={(event) => setRoleDraft(event.target.value as Role)}
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-[12px]"
              >
                {roles.map((item) => (
                  <option key={item} value={item}>
                    {roleLabel(item)}
                  </option>
                ))}
              </select>
              <p className="text-[10.5px] text-ink-400">
                Admin and owner changes follow the workspace ownership rules enforced by the API.
              </p>
            </div>
            {roleError && (
              <p role="alert" className="text-[11.5px] text-destructive">
                {roleError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                className="h-9 text-[12px]"
                onClick={() => setEditingMember(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={savingRole}
                className="h-9 bg-primary text-[12px] font-semibold text-primary-foreground"
              >
                {savingRole ? "Saving…" : "Save role"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

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
              disabled={busy === suspendTarget?.membership_id}
              onClick={() => suspendTarget && void suspend(suspendTarget)}
            >
              {busy === suspendTarget?.membership_id ? "Suspending…" : "Suspend access"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={Boolean(revokeTarget)}
        onOpenChange={(open) => !open && setRevokeTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this invitation?</AlertDialogTitle>
            <AlertDialogDescription>
              {revokeTarget
                ? `The invite token for ${revokeTarget.email} (${roleLabel(revokeTarget.role)}) stops working immediately.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={busy === revokeTarget?.id}
              onClick={() => revokeTarget && void revokeInvitation(revokeTarget)}
            >
              {busy === revokeTarget?.id ? "Revoking…" : "Revoke invitation"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
