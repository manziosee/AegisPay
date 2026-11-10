import type { FinanceCommitmentInput } from "./types";

export type FinanceCommitmentDraft = {
  id: string;
  organizationId: string;
  payload: FinanceCommitmentInput;
  idempotencyKey: string;
  createdAt: string;
  error?: string;
};

const databaseName = "aegispay-finance-drafts";
const storeName = "commitments";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("This browser does not support persistent offline drafts."));
      return;
    }
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) {
        request.result.createObjectStore(storeName, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Offline draft storage could not be opened."));
  });
}

async function useStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const request = operation(transaction.objectStore(storeName));
      let result: T;
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => reject(request.error ?? new Error("Offline draft storage request failed."));
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error ?? new Error("Offline draft storage transaction failed."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Offline draft storage transaction failed."));
    });
  } finally {
    database.close();
  }
}

export async function listFinanceDrafts(): Promise<FinanceCommitmentDraft[]> {
  const drafts = await useStore<FinanceCommitmentDraft[]>("readonly", (store) => store.getAll());
  return drafts.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function saveFinanceDraft(draft: FinanceCommitmentDraft): Promise<IDBValidKey> {
  return useStore<IDBValidKey>("readwrite", (store) => store.put(draft));
}

export function removeFinanceDraft(id: string): Promise<undefined> {
  return useStore<undefined>("readwrite", (store) => store.delete(id));
}
