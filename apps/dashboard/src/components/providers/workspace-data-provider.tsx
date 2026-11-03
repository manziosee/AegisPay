"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { canFinance, canReviewFraud } from "@/lib/roles";
import type {
  FraudCase,
  Organization,
  Page,
  ReconciliationImport,
  TransactionPolicy,
  TransactionReport,
  Transfer,
  WorkspaceData
} from "@/lib/types";
import { dateRangeDays } from "@/lib/format";
import { useSession } from "./session-provider";

type ResourceError = { resource: string; message: string };

type WorkspaceDataContextValue = {
  data: WorkspaceData;
  loading: boolean;
  errors: ResourceError[];
  refreshedAt: Date | null;
  refresh: () => Promise<void>;
  counts: {
    transactions: number;
    pendingApprovals: number;
    exceptionCount: number;
    openCases: number;
  };
  updateTransfers: (updater: (items: Transfer[]) => Transfer[]) => void;
  updateFraudCases: (updater: (items: FraudCase[]) => FraudCase[]) => void;
};

const emptyData: WorkspaceData = {
  organization: null,
  transactions: [],
  transactionCursor: null,
  transactionSummary: [],
  transfers: [],
  fraudCases: [],
  imports: [],
  policies: []
};

const WorkspaceDataContext = createContext<WorkspaceDataContextValue | null>(null);

export function WorkspaceDataProvider({ children }: { children: React.ReactNode }) {
  const { session, role, status } = useSession();
  const [data, setData] = useState<WorkspaceData>(emptyData);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<ResourceError[]>([]);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);

  const refresh = useCallback(async () => {
    if (!session || status !== "authenticated" || !role) return;
    setLoading(true);
    const collected: ResourceError[] = [];
    const load = async <T,>(resource: string, path: string): Promise<T | undefined> => {
      try {
        return await api<T>(path);
      } catch (error) {
        collected.push({ resource, message: errorMessage(error) });
        return undefined;
      }
    };

    const { from, to } = dateRangeDays(30);
    const reportQuery = new URLSearchParams({
      from: from.toISOString(),
      to: to.toISOString(),
      limit: "100"
    });

    const [report, transfers, cases, imports, organization, policies] = await Promise.all([
      role === "developer"
        ? Promise.resolve(undefined)
        : load<TransactionReport>(
            "Transactions",
            `/reports/transactions?${reportQuery.toString()}`
          ),
      role === "developer"
        ? Promise.resolve(undefined)
        : load<Page<Transfer>>("Transfers", "/transfers?limit=100"),
      canReviewFraud(role)
        ? load<{ data: FraudCase[] }>("Fraud cases", "/fraud/cases")
        : Promise.resolve(undefined),
      canFinance(role)
        ? load<Page<ReconciliationImport>>(
            "Reconciliation",
            "/reconciliation/imports?limit=100"
          )
        : Promise.resolve(undefined),
      load<Organization>("Organization", "/organizations"),
      canFinance(role)
        ? load<{ data: TransactionPolicy[] }>("Transaction policies", "/transaction-policies")
        : Promise.resolve(undefined)
    ]);

    setData({
      organization: organization ?? null,
      transactions: report?.data ?? [],
      transactionCursor: report?.next_cursor ?? null,
      transactionSummary: report?.summary ?? [],
      transfers: transfers?.data ?? [],
      fraudCases: cases?.data ?? [],
      imports: imports?.data ?? [],
      policies: policies?.data ?? []
    });
    setErrors(collected);
    setRefreshedAt(new Date());
    setLoading(false);
  }, [role, session, status]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const counts = useMemo(
    () => ({
      transactions: data.transactionSummary.reduce((sum, item) => sum + item.count, 0),
      pendingApprovals: data.transfers.filter((item) => item.status === "pending_approval")
        .length,
      exceptionCount: data.imports.reduce((sum, item) => sum + item.exception_count, 0),
      openCases: data.fraudCases.filter((item) => item.status !== "resolved").length
    }),
    [data]
  );

  const updateTransfers = useCallback((updater: (items: Transfer[]) => Transfer[]) => {
    setData((current) => ({ ...current, transfers: updater(current.transfers) }));
  }, []);

  const updateFraudCases = useCallback((updater: (items: FraudCase[]) => FraudCase[]) => {
    setData((current) => ({ ...current, fraudCases: updater(current.fraudCases) }));
  }, []);

  const value = useMemo<WorkspaceDataContextValue>(
    () => ({
      data,
      loading,
      errors,
      refreshedAt,
      refresh,
      counts,
      updateTransfers,
      updateFraudCases
    }),
    [data, loading, errors, refreshedAt, refresh, counts, updateTransfers, updateFraudCases]
  );

  return (
    <WorkspaceDataContext.Provider value={value}>{children}</WorkspaceDataContext.Provider>
  );
}

export function useWorkspaceData() {
  const context = useContext(WorkspaceDataContext);
  if (!context) {
    throw new Error("useWorkspaceData must be used inside WorkspaceDataProvider");
  }
  return context;
}

export function useWorkspaceDataOptional() {
  return useContext(WorkspaceDataContext);
}
