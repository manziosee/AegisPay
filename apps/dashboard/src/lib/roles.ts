import type { Role } from "./types";

export function isAdmin(role: Role | string | undefined) {
  return role === "owner" || role === "admin";
}

export function canFinance(role: Role | string | undefined) {
  return isAdmin(role) || role === "finance_operator";
}

export function canReviewFraud(role: Role | string | undefined) {
  return isAdmin(role) || role === "fraud_analyst";
}

export function canViewControls(role: Role | string | undefined) {
  return isAdmin(role) || role === "finance_operator" || role === "auditor";
}

export function canViewAccounts(role: Role | string | undefined) {
  return isAdmin(role) || role === "finance_operator" || role === "auditor";
}

export function canViewTransactions(role: Role | string | undefined) {
  return role !== "developer";
}
