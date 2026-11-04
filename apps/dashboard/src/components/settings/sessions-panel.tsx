"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Laptop } from "lucide-react";
import { toast } from "sonner";
import { Panel, PanelHeader } from "@/components/ui-blocks/panel";
import { Button } from "@/components/ui/button";
import { useSession } from "@/components/providers/session-provider";
import { api, errorMessage } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import type { UserSession } from "@/lib/types";

function device(agent: string) {
  if (!agent) return "Unknown device";
  const browser = /Edg\//.test(agent) ? "Edge" : /Firefox\//.test(agent) ? "Firefox" : /Chrome\//.test(agent) ? "Chrome" : /Safari\//.test(agent) ? "Safari" : /curl|python|Go-http/i.test(agent) ? "API client" : "Browser";
  const os = /Windows/.test(agent) ? "Windows" : /Mac OS X|Macintosh/.test(agent) ? "macOS" : /Android/.test(agent) ? "Android" : /iPhone|iPad/.test(agent) ? "iOS" : /Linux/.test(agent) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

/** The signed-in user's active sessions, with per-session and bulk sign-out. */
export function SessionsPanel() {
  const router = useRouter();
  const { logout } = useSession();
  const [sessions, setSessions] = useState<UserSession[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSessions((await api<{ data: UserSession[] }>("/auth/sessions")).data);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revokeOthers = async () => {
    setBusy("others");
    try {
      const result = await api<{ revoked: number }>("/auth/sessions/revoke-others", { method: "POST" });
      toast.success(result.revoked === 0 ? "No other sessions were active." : `Signed out ${result.revoked} other session${result.revoked === 1 ? "" : "s"}.`);
      await load();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (session: UserSession) => {
    setBusy(session.id);
    try {
      await api(`/auth/sessions/${encodeURIComponent(session.id)}/revoke`, { method: "POST" });
      if (session.current) {
        await logout();
        router.push("/login");
        return;
      }
      toast.success("Session signed out.");
      await load();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const others = (sessions ?? []).filter((session) => !session.current).length;

  return (
    <Panel className="mt-4">
      <PanelHeader
        title="Active sessions"
        description="Devices signed in to your account"
        action={
          <Button size="sm" variant="outline" className="h-8 text-[11.5px]" disabled={busy !== null || others === 0} onClick={() => void revokeOthers()}>
            Sign out everywhere else
          </Button>
        }
      />
      <ul>
        {(sessions ?? []).map((session) => (
          <li key={session.id} className="flex items-center gap-3 border-b border-border/70 px-5 py-3 last:border-0">
            <Laptop className="size-4 text-ink-400" />
            <div className="min-w-0 flex-1">
              <p className="text-[12.5px] text-ink-900">
                {device(session.user_agent)}
                {session.current && <span className="ml-2 rounded bg-mint-soft px-1.5 py-0.5 text-[10px] text-[#0d7a5f]">This device</span>}
              </p>
              <p className="text-[10.5px] text-ink-400">
                {session.ip_address || "Unknown IP"} · signed in {formatRelative(session.created_at)}
                {session.last_seen_at ? ` · active ${formatRelative(session.last_seen_at)}` : ""}
              </p>
            </div>
            <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={busy !== null} onClick={() => void revoke(session)}>
              Sign out
            </Button>
          </li>
        ))}
        {sessions?.length === 0 && <li className="px-5 py-3 text-[12px] text-ink-500">No active sessions.</li>}
      </ul>
    </Panel>
  );
}
