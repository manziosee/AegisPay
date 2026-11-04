"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ChevronRight, Plus, Settings } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSession } from "@/components/providers/session-provider";
import { api, errorMessage } from "@/lib/api";
import { roleLabel } from "@/lib/format";
import { browserCountry } from "@/lib/locale";
import type { Organization, WorkspaceMembership } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Sidebar control that lists the user's workspaces, switches between them and creates new ones. */
export function WorkspaceSwitcher({ organization }: { organization: Organization | null }) {
  const router = useRouter();
  const { session, switchOrganization } = useSession();
  const [workspaces, setWorkspaces] = useState<WorkspaceMembership[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [switching, setSwitching] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ name: "", country: "", type: "business" as "business" | "personal" });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  const name = organization?.name ?? "Your workspace";

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const result = await api<{ data: WorkspaceMembership[] }>("/auth/organizations");
      setWorkspaces(result.data);
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }, []);

  const select = async (id: string) => {
    if (id === session?.organization_id) return;
    setSwitching(id);
    try {
      await switchOrganization(id);
      toast.success("Workspace switched.");
      router.push("/app");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSwitching(null);
    }
  };

  const openCreate = () => {
    setForm({ name: "", country: browserCountry(), type: "business" });
    setCreateError("");
    setCreateOpen(true);
  };

  const create = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const country = form.country.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) {
      setCreateError("Enter a two-letter country code, for example US, GB, DE, KE or IN.");
      return;
    }
    setCreating(true);
    setCreateError("");
    try {
      const created = await api<{ id: string; name: string }>("/organizations", {
        method: "POST",
        body: JSON.stringify({ name: form.name.trim(), country_code: country, workspace_type: form.type })
      });
      setCreateOpen(false);
      setWorkspaces(null);
      await switchOrganization(created.id);
      toast.success(`${created.name} created. You are its owner.`);
      router.push("/app");
    } catch (error) {
      setCreateError(errorMessage(error));
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <DropdownMenu onOpenChange={(open) => open && void load()}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Switch workspace"
            className="flex w-full items-center gap-2.5 rounded-lg border border-white/8 bg-white/[0.03] px-2.5 py-2 text-left transition-colors hover:bg-white/[0.06]"
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-md bg-ink-800 text-[12px] font-semibold text-on-night">
              {name.slice(0, 1).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-medium text-on-night">{name}</span>
              <span className="block truncate text-[10.5px] capitalize text-on-night-muted">
                {organization?.workspace_type === "personal" ? "Personal sandbox" : "Business sandbox"}
              </span>
            </span>
            <ChevronRight className="size-3.5 rotate-90 text-on-night-muted" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[260px]">
          <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
          {workspaces === null && !loadError && (
            <p className="px-2 py-1.5 text-[11.5px] text-muted-foreground">Loading…</p>
          )}
          {loadError && <p className="px-2 py-1.5 text-[11.5px] text-destructive">{loadError}</p>}
          {workspaces?.map((item) => (
            <DropdownMenuItem
              key={item.id}
              disabled={switching !== null}
              onSelect={() => void select(item.id)}
              className="items-start"
            >
              <Check
                className={cn(
                  "mt-0.5 size-3.5",
                  item.id === session?.organization_id ? "opacity-100" : "opacity-0"
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px]">{item.name}</span>
                <span className="block text-[10.5px] text-muted-foreground">
                  {roleLabel(item.role)} · {item.workspace_type} · {item.country_code}
                  {switching === item.id ? " · switching…" : ""}
                </span>
              </span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={openCreate}>
            <Plus className="size-3.5" />
            Create workspace
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/app/settings">
              <Settings className="size-3.5" />
              Workspace settings
            </Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle className="text-[16px]">Create a workspace</DialogTitle>
            <DialogDescription className="text-[12px]">
              You become its owner. Records, members and keys are separate from your other workspaces.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={create} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="workspace-name">Name</Label>
              <Input
                id="workspace-name"
                value={form.name}
                required
                maxLength={120}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                className="h-9 text-[12px]"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="workspace-country">Country code</Label>
                <Input
                  id="workspace-country"
                  value={form.country}
                  required
                  maxLength={2}
                  placeholder="US"
                  onChange={(event) => setForm({ ...form, country: event.target.value.toUpperCase() })}
                  className="h-9 font-mono text-[12px]"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="workspace-type">Type</Label>
                <select
                  id="workspace-type"
                  value={form.type}
                  onChange={(event) => setForm({ ...form, type: event.target.value as "business" | "personal" })}
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-[12px]"
                >
                  <option value="business">Business</option>
                  <option value="personal">Personal</option>
                </select>
              </div>
            </div>
            {createError && (
              <p role="alert" className="text-[11.5px] text-destructive">
                {createError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" className="h-9 text-[12px]" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={creating} className="h-9 bg-primary text-[12px] font-semibold text-primary-foreground">
                {creating ? "Creating…" : "Create workspace"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
