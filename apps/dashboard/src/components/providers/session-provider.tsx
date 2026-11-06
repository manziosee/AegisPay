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
import { api, setOrganizationId, setUnauthorizedHandler } from "@/lib/api";
import type { Principal, Role, Session } from "@/lib/types";

// Earlier builds kept the bearer token here; it is removed on load.
const LEGACY_STORAGE_KEY = "aegispay.session";
// Selected workspace (not a secret); sent as X-Organization-ID.
const ORGANIZATION_KEY = "aegispay.organization";

function rememberOrganization(id: string | null) {
  setOrganizationId(id);
  try {
    if (id) localStorage.setItem(ORGANIZATION_KEY, id);
    else localStorage.removeItem(ORGANIZATION_KEY);
  } catch {
    // Storage can be unavailable (private mode); the header still applies.
  }
}

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
  accepted_terms?: boolean;
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
  switchOrganization: (organizationId: string) => Promise<void>;
  logout: () => Promise<void>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

function sessionFromPrincipal(actor: Principal): Session {
  return {
    user_id: actor.user_id,
    full_name: actor.full_name,
    organization_id: actor.organization_id,
    role: actor.role,
    expires_at: actor.expires_at ?? ""
  };
}

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
      user_id: value.user_id,
      organization_id: value.organization_id,
      role: value.role,
      expires_at: value.expires_at,
      full_name: value.full_name || fallbackName || undefined
    };
    rememberOrganization(normalized.organization_id);
    setSession(normalized);
    setPrincipal(principalFromSession(normalized));
    setStatus("authenticated");
    return normalized;
  }, []);

  useEffect(() => {
    let active = true;
    const restore = async () => {
      sessionStorage.removeItem(LEGACY_STORAGE_KEY);
      let stored: string | null = null;
      try {
        stored = localStorage.getItem(ORGANIZATION_KEY);
      } catch {
        stored = null;
      }
      setOrganizationId(stored);
      // The httpOnly session cookie is sent automatically; a 401 here just
      // means nobody is signed in (or the stored workspace is no longer ours).
      const probe = () => api<Principal>("/auth/me", { anonymous: true });
      try {
        let actor: Principal;
        try {
          actor = await probe();
        } catch (error) {
          if (!stored) throw error;
          rememberOrganization(null);
          actor = await probe();
        }
        if (!active) return;
        rememberOrganization(actor.organization_id);
        setSession(sessionFromPrincipal(actor));
        setPrincipal(actor);
        setStatus("authenticated");
      } catch {
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
        { method: "POST", anonymous: true, body: JSON.stringify({ email: email.trim(), password }) }
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
      const result = await api<Session>("/auth/register", {
        method: "POST",
        anonymous: true,
        body: JSON.stringify({
          full_name: input.full_name.trim(),
          email: input.email.trim(),
          password: input.password,
          workspace_type: input.workspace_type,
          organization_name:
            input.workspace_type === "business" ? input.organization_name.trim() : "",
          country_code: input.country_code,
          accepted_terms: input.accepted_terms
        })
      });
      persist(result, input.full_name);
      return result;
    },
    [persist]
  );

  const verifyMfa = useCallback(
    async (mfaToken: string, code: string) => {
      const result = await api<Session>("/auth/mfa/verify-login", {
        method: "POST",
        anonymous: true,
        body: JSON.stringify({ mfa_token: mfaToken, code })
      });
      persist(result);
      return result;
    },
    [persist]
  );

  const switchOrganization = useCallback(async (organizationId: string) => {
    const previous = session?.organization_id ?? null;
    setOrganizationId(organizationId);
    try {
      const actor = await api<Principal>("/auth/me");
      rememberOrganization(actor.organization_id);
      setSession(sessionFromPrincipal(actor));
      setPrincipal(actor);
    } catch (error) {
      setOrganizationId(previous);
      throw error;
    }
  }, [session]);

  const logout = useCallback(async () => {
    try {
      // The proxy clears the session cookie even if revocation fails upstream.
      await api("/auth/logout", { method: "POST", anonymous: true });
    } catch {
      // The local state must still be cleared if revocation fails.
    }
    rememberOrganization(null);
    setSession(null);
    setPrincipal(null);
    setStatus("anonymous");
  }, []);

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
      switchOrganization,
      logout
    }),
    [session, principal, status, login, register, verifyMfa, switchOrganization, logout]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const context = useContext(SessionContext);
  if (!context) throw new Error("useSession must be used inside SessionProvider");
  return context;
}
