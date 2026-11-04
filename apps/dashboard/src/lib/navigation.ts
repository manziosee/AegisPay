import {
  ArrowLeftRight,
  BadgeCheck,
  BookOpen,
  Building2,
  Gauge,
  HandCoins,
  KeyRound,
  Landmark,
  UserRound,
  Network,
  Send,
  Settings,
  ShieldAlert,
  Users,
  Webhook,
  Workflow
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Role } from "./types";
import { canFinance, canReviewFraud, canViewAccounts, canViewControls, isAdmin } from "./roles";

export type NavGroup = "Operate" | "Intelligence" | "Developers" | "Admin";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  group: NavGroup;
  description: string;
  keywords?: string;
  visible: (role: Role | string) => boolean;
  badgeKey?: "approvals" | "exceptions" | "cases";
};

export const workspaceNav: NavItem[] = [
  {
    href: "/app",
    label: "Overview",
    icon: Gauge,
    group: "Operate",
    description: "Work queue, currency position and recent activity",
    keywords: "home dashboard triage queue",
    visible: () => true
  },
  {
    href: "/app/transactions",
    label: "Transactions",
    icon: ArrowLeftRight,
    group: "Operate",
    description: "Collections, transfers and refunds",
    keywords: "ledger records report",
    visible: (role) => role !== "developer"
  },
  {
    href: "/app/approvals",
    label: "Approvals",
    icon: BadgeCheck,
    group: "Operate",
    description: "Transfers awaiting a second reviewer",
    keywords: "maker checker review decision",
    visible: (role) => isAdmin(role),
    badgeKey: "approvals"
  },
  {
    href: "/app/payments",
    label: "Collections and transfers",
    icon: HandCoins,
    group: "Operate",
    description: "Create, confirm and refund collections; move funds between accounts",
    keywords: "collection payment confirm refund transfer send",
    visible: (role) => canFinance(role)
  },
  {
    href: "/app/customers",
    label: "Customers",
    icon: UserRound,
    group: "Operate",
    description: "People and businesses you collect from",
    keywords: "customer payer directory contact",
    visible: (role) => canFinance(role) || role === "auditor"
  },
  {
    href: "/app/reconciliation",
    label: "Reconciliation",
    icon: Landmark,
    group: "Operate",
    description: "Statement imports and open exceptions",
    keywords: "statement match bank import",
    visible: (role) => canFinance(role),
    badgeKey: "exceptions"
  },
  {
    href: "/app/money",
    label: "Receive and send money",
    icon: Send,
    group: "Operate",
    description: "Payment requests, payout register and statements",
    keywords: "payout request bank file",
    visible: (role) => canFinance(role)
  },
  {
    href: "/app/intelligence",
    label: "Risk review",
    icon: ShieldAlert,
    group: "Intelligence",
    description: "Evaluate transactions and investigate cases",
    keywords: "fraud score signals network aegis intelligence",
    visible: (role) => canReviewFraud(role),
    badgeKey: "cases"
  },
  {
    href: "/app/risk-rules",
    label: "Risk rules",
    icon: Workflow,
    group: "Intelligence",
    description: "Allow, review or block payments before they are recorded",
    keywords: "rules velocity limits block review routing fraud",
    visible: (role) => canReviewFraud(role) || canFinance(role) || role === "auditor" || role === "developer"
  },
  {
    href: "/app/accounts",
    label: "Accounts",
    icon: BookOpen,
    group: "Intelligence",
    description: "Multi-currency balances and ledger entries",
    keywords: "wallet currency balance",
    visible: (role) => canViewAccounts(role)
  },
  {
    href: "/app/developers",
    label: "API keys",
    icon: KeyRound,
    group: "Developers",
    description: "Create, rotate and revoke server credentials",
    keywords: "api key token secret rotate revoke developer",
    visible: (role) => isAdmin(role) || role === "developer"
  },
  {
    href: "/app/webhooks",
    label: "Webhooks",
    icon: Webhook,
    group: "Developers",
    description: "Endpoints, delivery attempts and retries",
    keywords: "events deliveries signature",
    visible: (role) => isAdmin(role) || role === "developer"
  },
  {
    href: "/app/controls",
    label: "Close and controls",
    icon: Network,
    group: "Admin",
    description: "Period close, delegation and audit trail",
    keywords: "period audit delegation simulator",
    visible: (role) => canViewControls(role)
  },
  {
    href: "/app/team",
    label: "Team access",
    icon: Users,
    group: "Admin",
    description: "Members, invitations and access",
    keywords: "invite members roles",
    visible: (role) => isAdmin(role)
  },
  {
    href: "/app/settings",
    label: "Organization settings",
    icon: Settings,
    group: "Admin",
    description: "Workspace profile and transaction policies",
    keywords: "policy limits currency organization",
    visible: () => true
  }
];

export const navGroups: NavGroup[] = ["Operate", "Intelligence", "Developers", "Admin"];

export function visibleNav(role: Role | string) {
  return workspaceNav.filter((item) => item.visible(role));
}

export const settingsIcon = Settings;
export const organizationIcon = Building2;
