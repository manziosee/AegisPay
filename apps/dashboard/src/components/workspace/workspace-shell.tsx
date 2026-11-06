"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Bell,
  Building2,
  ChevronRight,
  LogOut,
  Menu,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck
} from "lucide-react";
import { Wordmark } from "@/components/brand/logo";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCommand } from "@/components/providers/command-provider";
import { useSession } from "@/components/providers/session-provider";
import { useWorkspaceData } from "@/components/providers/workspace-data-provider";
import { WorkspaceSwitcher } from "@/components/workspace/workspace-switcher";
import { EmailBanner } from "@/components/workspace/email-banner";
import { navGroups, visibleNav, type NavItem } from "@/lib/navigation";
import { initials, roleLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

function badgeFor(item: NavItem, counts: ReturnType<typeof useWorkspaceData>["counts"]) {
  if (item.badgeKey === "approvals") return counts.pendingApprovals;
  if (item.badgeKey === "exceptions") return counts.exceptionCount;
  if (item.badgeKey === "cases") return counts.openCases;
  return 0;
}

function NavList({
  role,
  pathname,
  counts,
  onNavigate,
  compact = false
}: {
  role: string;
  pathname: string;
  counts: ReturnType<typeof useWorkspaceData>["counts"];
  onNavigate?: () => void;
  compact?: boolean;
}) {
  const items = visibleNav(role);

  return (
    <nav aria-label="Workspace navigation" className="space-y-5">
      {navGroups.map((group) => {
        const groupItems = items.filter((item) => item.group === group);
        if (!groupItems.length) return null;
        return (
          <div key={group}>
            <p className="mb-1.5 px-3 font-mono text-[9.5px] uppercase tracking-[0.12em] text-on-night-muted/50">
              {group}
            </p>
            <ul className="space-y-0.5">
              {groupItems.map((item) => {
                const Icon = item.icon;
                const active =
                  pathname === item.href ||
                  (item.href !== "/app" && pathname.startsWith(`${item.href}/`));
                const count = badgeFor(item, counts);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "group flex items-center gap-2.5 rounded-lg px-3 text-[13px] transition-colors",
                        compact ? "h-9" : "h-9",
                        active
                          ? "bg-ink-800 font-medium text-white"
                          : "text-on-night-muted hover:bg-white/5 hover:text-on-night"
                      )}
                    >
                      <Icon
                        className={cn(
                          "size-4 shrink-0",
                          active ? "text-mint" : "text-on-night-muted/70"
                        )}
                        strokeWidth={1.8}
                      />
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {count > 0 && (
                        <span className="rounded-md bg-amber-bright/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-bright">
                          {count > 99 ? "99+" : count}
                        </span>
                      )}
                      {active && <span className="size-1.5 rounded-full bg-mint" />}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

export function WorkspaceShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { role, fullName, session, logout } = useSession();
  const { data, counts, loading, refresh, errors } = useWorkspaceData();
  const { setOpen: openCommand } = useCommand();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
  }, []);

  const safeRole = role ?? session?.role ?? "member";
  const items = visibleNav(safeRole);
  const current =
    items.find(
      (item) =>
        pathname === item.href ||
        (item.href !== "/app" && pathname.startsWith(`${item.href}/`))
    ) ?? items[0];
  const totalAlerts = counts.pendingApprovals + counts.exceptionCount + counts.openCases;
  const organizationName = data.organization?.name ?? "Your workspace";
  const isLive = data.organization?.environment === "live";

  const signOut = async () => {
    await logout();
    router.push("/");
  };

  const doRefresh = async () => {
    await refresh();
  };

  const sidebarContent = (
    <>
      <div className="flex h-16 shrink-0 items-center justify-between border-b border-white/8 px-5">
        <Link href="/app" aria-label="AegisPay overview">
          <Wordmark size="sm" />
        </Link>
        <span className="rounded border border-white/12 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-on-night-muted">
          {isLive ? "Live" : "Practice"}
        </span>
      </div>

      <div className="px-3 py-4">
        <WorkspaceSwitcher organization={data.organization} />
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-4">
        <NavList role={safeRole} pathname={pathname} counts={counts} onNavigate={() => setMobileOpen(false)} />
      </div>

      <div className="shrink-0 border-t border-white/8 p-3">
        <div className="mb-2 flex items-start gap-2 rounded-lg border border-mint/15 bg-mint/[0.06] px-2.5 py-2">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-mint" />
          <div>
            <p className="text-[11px] font-medium text-[#bfe9dd]">{isLive ? "Live workspace" : "Practice workspace"}</p>
            <p className="mt-0.5 text-[10px] leading-relaxed text-on-night-muted">
              {isLive ? "Money is confirmed by your bank statements" : "Simulated money, safe to explore"}
            </p>
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-white/5"
            >
              <Avatar className="size-8 border border-white/10">
                <AvatarFallback className="bg-ink-800 text-[11px] text-on-night">
                  {initials(fullName)}
                </AvatarFallback>
              </Avatar>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-medium text-on-night">
                  {fullName ?? "Workspace user"}
                </span>
                <span className="block truncate text-[10.5px] capitalize text-on-night-muted">
                  {roleLabel(safeRole)}
                </span>
              </span>
              <ChevronRight className="size-3.5 rotate-90 text-on-night-muted" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-[220px]">
            <DropdownMenuLabel className="font-normal">
              <p className="text-[12.5px] font-medium text-ink-900">{fullName ?? "Workspace user"}</p>
              <p className="mt-0.5 text-[11px] capitalize text-muted-foreground">
                {roleLabel(safeRole)}
              </p>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/app/settings">
                <Settings className="size-3.5" />
                Settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={() => void signOut()}>
              <LogOut className="size-3.5" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );

  return (
    <div data-app-hydrated={hydrated ? "true" : "false"} className="min-h-screen bg-paper">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[248px] flex-col bg-ink-900 lg:flex">
        {sidebarContent}
      </aside>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="flex w-[86vw] max-w-[300px] flex-col border-white/10 bg-ink-900 p-0 text-on-night">
          <SheetHeader className="sr-only">
            <SheetTitle>Workspace navigation</SheetTitle>
          </SheetHeader>
          {sidebarContent}
        </SheetContent>
      </Sheet>

      <div className="lg:pl-[248px]">
        <header className="sticky top-0 z-30 border-b border-border bg-paper/90 backdrop-blur-md">
          <div className="flex h-16 items-center gap-3 px-4 sm:px-6">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Open navigation"
              className="size-8 lg:hidden"
              onClick={() => setMobileOpen(true)}
            >
              <Menu className="size-4" />
            </Button>

            <div className="flex min-w-0 items-center gap-2 text-[12px]">
              <span className="hidden text-ink-400 sm:inline">Workspace</span>
              <ChevronRight className="hidden size-3.5 text-ink-300 sm:inline" />
              <span className="truncate font-medium text-ink-900">
                {current?.label ?? "Overview"}
              </span>
            </div>

            <div className="ml-auto flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => openCommand(true)}
                className="inline-flex h-8 items-center gap-2 rounded-md border border-border bg-card px-2.5 text-[12px] text-ink-400 transition-colors hover:text-ink-900"
                aria-label="Search or jump to"
              >
                <Search className="size-3.5" />
                <span className="hidden sm:inline">Search or jump to</span>
                <Kbd className="hidden sm:inline-flex">⌘K</Kbd>
              </button>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Refresh data"
                    onClick={() => void doRefresh()}
                    disabled={loading}
                    className="size-8 text-ink-500"
                  >
                    <RefreshCw className={cn("size-4", loading && "animate-spin")} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Refresh workspace data</TooltipContent>
              </Tooltip>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Notifications"
                    className="relative size-8 text-ink-500"
                  >
                    <Bell className="size-4" />
                    {totalAlerts > 0 && (
                      <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-amber-bright" />
                    )}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-[280px]">
                  <DropdownMenuLabel>Open work</DropdownMenuLabel>
                  <DropdownMenuItem asChild>
                    <Link href="/app/approvals" className="justify-between">
                      <span>Transfers awaiting approval</span>
                      <span className="font-mono text-[11px]">{counts.pendingApprovals}</span>
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href="/app/reconciliation" className="justify-between">
                      <span>Reconciliation exceptions</span>
                      <span className="font-mono text-[11px]">{counts.exceptionCount}</span>
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href="/app/intelligence" className="justify-between">
                      <span>Open risk cases</span>
                      <span className="font-mono text-[11px]">{counts.openCases}</span>
                    </Link>
                  </DropdownMenuItem>
                  {totalAlerts === 0 && (
                    <p className="px-2 py-3 text-[12px] text-muted-foreground">No open items.</p>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label="Account menu"
                    className="ml-0.5 rounded-full focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Avatar className="size-8 border border-border">
                      <AvatarFallback className="bg-ink-800 text-[11px] text-on-night">
                        {initials(fullName)}
                      </AvatarFallback>
                    </Avatar>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-[230px]">
                  <DropdownMenuLabel className="font-normal">
                    <p className="text-[12.5px] font-medium text-ink-900">{fullName ?? "Workspace user"}</p>
                    <p className="mt-0.5 text-[11px] capitalize text-muted-foreground">
                      {roleLabel(safeRole)} · {organizationName}
                    </p>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <Link href="/app/settings">
                      <Building2 className="size-3.5" />
                      Organization settings
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onSelect={() => void signOut()}>
                    <LogOut className="size-3.5" />
                    Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </header>

        {errors.length > 0 && (
          <div className="border-b border-amber/20 bg-amber-soft/60 px-4 py-2 sm:px-6">
            <p className="mx-auto max-w-[1440px] text-[11.5px] leading-relaxed text-[#8a5a12]">
              {errors.length} workspace resource{errors.length === 1 ? "" : "s"} could not be
              loaded: {errors.map((error) => `${error.resource} — ${error.message}`).join("; ")}
            </p>
          </div>
        )}

        <EmailBanner />
        <main className="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6 lg:py-7">
          {children}
        </main>
      </div>
    </div>
  );
}
