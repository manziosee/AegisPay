"use client";

import { useMemo } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  ArrowLeftRight,
  BadgeCheck,
  BookOpen,
  FileUp,
  Landmark,
  LogIn,
  LogOut,
  Search,
  ShieldAlert,
  SquarePen,
  UserPlus
} from "lucide-react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut
} from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { useCommand } from "@/components/providers/command-provider";
import { useSession } from "@/components/providers/session-provider";
import { useWorkspaceDataOptional } from "@/components/providers/workspace-data-provider";
import { visibleNav } from "@/lib/navigation";
import { formatMinor } from "@/lib/format";

const marketingLinks = [
  { label: "Platform", href: "/#platform" },
  { label: "One transaction, end to end", href: "/#transaction" },
  { label: "Aegis Intelligence", href: "/#intelligence" },
  { label: "Developer surface", href: "/#developers" },
  { label: "Sandbox boundaries", href: "/#sandbox" }
];

export function CommandPalette() {
  const { open, setOpen } = useCommand();
  const { status, role, session, logout } = useSession();
  const workspace = useWorkspaceDataOptional();
  const router = useRouter();
  const pathname = usePathname();

  const inWorkspace = pathname?.startsWith("/app") ?? false;
  const navItems = useMemo(
    () => (role ? visibleNav(role) : []),
    [role]
  );

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  const data = workspace?.data;

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Search AegisPay"
      description="Search pages, actions and records in this workspace."
      className="top-[10vh] w-[min(660px,calc(100vw-2rem))] translate-y-0 border-border/80 shadow-lift"
    >
      <Command className="bg-transparent p-0">
        <CommandInput placeholder="Search pages, actions and records" />
      <CommandList className="max-h-[min(520px,68vh)] px-1 pb-1">
        <CommandEmpty className="px-4 py-8 text-center text-small text-ink-500">
          No matches. Try a reference, a page name, or an action.
        </CommandEmpty>

        {inWorkspace && (
          <CommandGroup heading="Actions">
            <CommandItem
              value="evaluate transaction risk score intelligence"
              onSelect={() => go("/app/intelligence")}
            >
              <ShieldAlert className="text-ink-400" />
              Evaluate a transaction
            </CommandItem>
            <CommandItem
              value="create payment request receive money"
              onSelect={() => go("/app/money")}
            >
              <SquarePen className="text-ink-400" />
              Create a payment request
            </CommandItem>
            <CommandItem
              value="import bank statement csv reconciliation"
              onSelect={() => go("/app/money#statement")}
            >
              <FileUp className="text-ink-400" />
              Import a bank statement
            </CommandItem>
            <CommandItem value="invite teammate team access" onSelect={() => go("/app/team")}>
              <UserPlus className="text-ink-400" />
              Invite a teammate
            </CommandItem>
          </CommandGroup>
        )}

        {inWorkspace && navItems.length > 0 && (
          <CommandGroup heading="Go to">
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <CommandItem
                  key={item.href}
                  value={`${item.label} ${item.description} ${item.keywords ?? ""}`}
                  onSelect={() => go(item.href)}
                >
                  <Icon className="text-ink-400" />
                  <span className="shrink-0">{item.label}</span>
                  <span className="ml-2 hidden min-w-0 truncate text-caption text-ink-400 sm:block">
                    {item.description}
                  </span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}

        {inWorkspace && data && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Records">
              {data.transactions.slice(0, 8).map((transaction) => (
                <CommandItem
                  key={`tx-${transaction.id}`}
                  value={`${transaction.reference} ${transaction.id} ${transaction.type} ${transaction.status}`}
                  onSelect={() =>
                    go(`/app/transactions?q=${encodeURIComponent(transaction.reference)}`)
                  }
                >
                  <ArrowLeftRight className="text-ink-400" />
                  <span className="font-mono text-caption">{transaction.reference}</span>
                  <span className="ml-2 text-caption text-ink-400">
                    {formatMinor(transaction.amount_minor, transaction.currency)} ·{" "}
                    {transaction.type}
                  </span>
                </CommandItem>
              ))}
              {data.transfers.slice(0, 5).map((transfer) => (
                <CommandItem
                  key={`tr-${transfer.id}`}
                  value={`${transfer.reference} ${transfer.id} ${transfer.status}`}
                  onSelect={() => go("/app/approvals")}
                >
                  <BadgeCheck className="text-ink-400" />
                  <span className="font-mono text-caption">{transfer.reference}</span>
                  <span className="ml-2 text-caption text-ink-400">
                    {formatMinor(transfer.amount, transfer.currency)} · {transfer.status}
                  </span>
                </CommandItem>
              ))}
              {data.imports.slice(0, 5).map((item) => (
                <CommandItem
                  key={`im-${item.id}`}
                  value={`${item.source_name} ${item.id} statement import`}
                  onSelect={() => go(`/app/reconciliation?import=${item.id}`)}
                >
                  <Landmark className="text-ink-400" />
                  <span className="text-caption">{item.source_name}</span>
                  <span className="ml-2 text-caption text-ink-400">
                    {item.exception_count} exceptions
                  </span>
                </CommandItem>
              ))}
              {data.fraudCases.slice(0, 5).map((item) => (
                <CommandItem
                  key={`fc-${item.id}`}
                  value={`${item.transaction_reference} ${item.id} fraud case risk`}
                  onSelect={() => go("/app/intelligence")}
                >
                  <ShieldAlert className="text-ink-400" />
                  <span className="font-mono text-caption">{item.transaction_reference}</span>
                  <span className="ml-2 text-caption text-ink-400">
                    score {item.risk_score}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {!inWorkspace && (
          <CommandGroup heading="Explore">
            {marketingLinks.map((item) => (
              <CommandItem
                key={item.href}
                value={`${item.label} page`}
                onSelect={() => go(item.href)}
              >
                <Search className="text-ink-400" />
                {item.label}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        <CommandSeparator />
        <CommandGroup heading={status === "authenticated" ? "Account" : "Access"}>
          {status === "authenticated" ? (
            <>
              {!inWorkspace && (
                <CommandItem value="open workspace dashboard" onSelect={() => go("/app")}>
                  <BookOpen className="text-ink-400" />
                  Open workspace
                  <CommandShortcut>{session?.full_name ?? "Signed in"}</CommandShortcut>
                </CommandItem>
              )}
              <CommandItem
                value="sign out logout"
                onSelect={async () => {
                  setOpen(false);
                  await logout();
                  router.push("/");
                }}
              >
                <LogOut className="text-ink-400" />
                Sign out
              </CommandItem>
            </>
          ) : (
            <>
              <CommandItem value="sign in login" onSelect={() => go("/login")}>
                <LogIn className="text-ink-400" />
                Sign in
              </CommandItem>
              <CommandItem
                value="create free account register"
                onSelect={() => go("/register")}
              >
                <UserPlus className="text-ink-400" />
                Create free account
              </CommandItem>
            </>
          )}
        </CommandGroup>
      </CommandList>
        <div className="flex items-center justify-between border-t border-border/70 px-4 py-2.5 text-[11px] text-ink-400">
          <span className="flex items-center gap-2">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            to navigate
          </span>
          <span className="flex items-center gap-2">
            <Kbd>↵</Kbd>
            to open
            <Kbd>esc</Kbd>
            to close
          </span>
        </div>
      </Command>
    </CommandDialog>
  );
}
