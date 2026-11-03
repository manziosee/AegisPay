"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { api, setUnauthorizedHandler } from "@/lib/api";
import type { Principal, Role, Session } from "@/lib/types";

const STORAGE_KEY = "aegispay.session";

type AuthStatus = "restoring" | "anonymous" | "authenticated";

type LoginResult =
  | { mfaRequired: true; mfaToken: string }
  | { mfaRequired: false; session: Session };

type RegisterInput = {
  full_name: string;
  email: string;
  password: string;
  workspace_type: "personal" | "business";
  organization_name: string;
  country_code?: string;
};

type SessionContextValue = {
  session: Session | null;
  principal: Principal | null;
  status: AuthStatus;
  role: Role | null;
  fullName: string | undefined;
  login: (email: string, password: string) => Promise<LoginResult>;
  register: (input: RegisterInput) => Promise<Session>;
  verifyMfa: (mfaToken: string, code: string) => Promise<Session>;
  logout: () => Promise<void>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

function principalFromSession(session: Session): Principal {
  return {
    organization_id: session.organization_id,
    user_id: session.user_id,
    role: session.role,
    credential_type: "user"
  };
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [status, setStatus] = useState<AuthStatus>("restoring");
  const handlingUnauthorized = useRef(false);

  const persist = useCallback((value: Session, fallbackName?: string) => {
    const normalized: Session = {
      ...value,
      full_name: value.full_name || fallbackName || undefined
    };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    setSession(normalized);
    setPrincipal(principalFromSession(normalized));
    setStatus("authenticated");
    return normalized;
  }, []);

  useEffect(() => {
    let active = true;
    const restore = async () => {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) {
        if (active) setStatus("anonymous");
        return;
      }
      try {
        const saved = JSON.parse(raw) as Session;
        if (!saved?.access_token) throw new Error("missing token");
        const actor = await api<Principal>("/auth/me", saved.access_token);
        if (!active) return;
        setSession(saved);
        setPrincipal(actor);
        setStatus("authenticated");
      } catch {
        sessionStorage.removeItem(STORAGE_KEY);
        if (active) setStatus("anonymous");
      }
    };
    void restore();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      if (handlingUnauthorized.current) return;
      handlingUnauthorized.current = true;
      sessionStorage.removeItem(STORAGE_KEY);
      setSession(null);
      setPrincipal(null);
      setStatus("anonymous");
      toast.error("Session expired. Sign in again.");
      const path = `${window.location.pathname}${window.location.search}`;
      if (!path.startsWith("/login") && !path.startsWith("/register")) {
        router.replace(`/login?next=${encodeURIComponent(path)}`);
      }
      window.setTimeout(() => {
        handlingUnauthorized.current = false;
      }, 1500);
    });
    return () => setUnauthorizedHandler(null);
  }, [router]);

  const login = useCallback(
    async (email: string, password: string): Promise<LoginResult> => {
      const result = await api<Session & { mfa_required?: boolean; mfa_token?: string }>(
        "/auth/login",
        undefined,
        { method: "POST", body: JSON.stringify({ email: email.trim(), password }) }
      );
      if (result.mfa_required && result.mfa_token) {
        return { mfaRequired: true, mfaToken: result.mfa_token };
      }
      persist(result);
      return { mfaRequired: false, session: result };
    },
    [persist]
  );

  const register = useCallback(
    async (input: RegisterInput) => {
      const result = await api<Session>("/auth/register", undefined, {
        method: "POST",
        body: JSON.stringify({
          full_name: input.full_name.trim(),
          email: input.email.trim(),
          password: input.password,
          workspace_type: input.workspace_type,
          organization_name:
            input.workspace_type === "business" ? input.organization_name.trim() : "",
          country_code: input.country_code ?? "RW"
        })
      });
      persist(result, input.full_name);
      return result;
    },
    [persist]
  );

  const verifyMfa = useCallback(
    async (mfaToken: string, code: string) => {
      const result = await api<Session>("/auth/mfa/verify-login", undefined, {
        method: "POST",
        body: JSON.stringify({ mfa_token: mfaToken, code })
      });
      persist(result);
      return result;
    },
    [persist]
  );

  const logout = useCallback(async () => {
    if (session) {
      try {
        await api("/auth/logout", session.access_token, { method: "POST" });
      } catch {
        // The local session must still be cleared if revocation fails.
      }
    }
    sessionStorage.removeItem(STORAGE_KEY);
    setSession(null);
    setPrincipal(null);
    setStatus("anonymous");
  }, [session]);

  const value = useMemo<SessionContextValue>(
    () => ({
      session,
      principal,
      status,
      role: (principal?.role ?? session?.role ?? null) as Role | null,
      fullName: session?.full_name,
      login,
      register,
      verifyMfa,
      logout
    }),
    [session, principal, status, login, register, verifyMfa, logout]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const context = useContext(SessionContext);
  if (!context) throw new Error("useSession must be used inside SessionProvider");
  return context;
}
