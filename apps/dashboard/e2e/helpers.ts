import { expect, type Page } from "@playwright/test";

const now = "2026-11-03T12:00:00.000Z";
const transfer = {
  id: "trf_demo_1",
  status: "pending_approval",
  currency: "RWF",
  reference: "PAYROLL-NOV",
  amount: 125000,
  created_at: now,
  approvals_received: 0,
  required_approvals: 2
};
const reconciliationLine = {
  line_id: 17,
  external_reference: "BANK-REF-17",
  amount: 48000,
  provider_fee: 2000,
  gross_amount: 50000,
  currency: "RWF",
  transaction_date: now,
  match_status: "exception",
  collection_id: null
};
const fraudCase = {
  id: "case_demo_1",
  status: "open",
  priority: "high",
  created_at: now,
  transaction_reference: "COL-REVIEW-9",
  risk_score: 78,
  risk_level: "high"
};
const transaction = {
  id: "col_demo_1",
  type: "collection",
  status: "succeeded",
  reference: "ORDER-1042",
  amount_minor: 74500,
  currency: "RWF",
  created_at: now
};

type MockOptions = {
  role?: "owner" | "finance_operator" | "fraud_analyst" | "auditor";
  onApproved?: (body: unknown, key: string | null) => void;
  onRejected?: (body: unknown, key: string | null) => void;
  onReconciliationResolved?: (body: unknown) => void;
  onFraudResolved?: (body: unknown) => void;
};

/**
 * Clicks the visibility toggle until the controlled input actually changes type.
 * This proves the client component is hydrated before tests type into it.
 */
export async function ensureHydratedPasswordToggle(page: Page, inputSelector: string) {
  await expect
    .poll(
      async () => {
        const type = await page.locator(inputSelector).getAttribute("type");
        if (type === "password") {
          await page.getByRole("button", { name: "Show characters" }).click();
        }
        return page.locator(inputSelector).getAttribute("type");
      },
      { timeout: 15000, intervals: [150, 300, 600, 1000] }
    )
    .toBe("text");
  await page.getByRole("button", { name: "Hide characters" }).click();
  await expect(page.locator(inputSelector)).toHaveAttribute("type", "password");
}

export async function signInWithMockWorkspace(page: Page, options: MockOptions = {}) {
  const role = options.role ?? "owner";
  let approved = false;
  let reconciliationResolved = false;
  let fraudResolved = false;
  // Mirrors the httpOnly session cookie: /auth/me answers 401 until sign-in.
  let signedIn = false;

  await page.route("**/proxy/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/proxy/v1", "");
    const method = request.method();
    if (path === "/auth/login" && method === "POST") {
      signedIn = true;
      await route.fulfill({
        json: {
          user_id: "usr_demo",
          full_name: "Avery Demo",
          organization_id: "org_demo",
          role,
          expires_at: now
        }
      });
      return;
    }
    if (path === "/auth/me") {
      if (!signedIn) {
        await route.fulfill({ status: 401, json: { error: "unauthorized" } });
        return;
      }
      await route.fulfill({
        json: { organization_id: "org_demo", user_id: "usr_demo", role, credential_type: "user" }
      });
      return;
    }
    if (path === "/organizations") {
      await route.fulfill({
        json: {
          id: "org_demo",
          name: "Acme Studio",
          workspace_type: "business",
          slug: "acme",
          country_code: "RW",
          status: "active",
          created_at: now
        }
      });
      return;
    }
    if (path.startsWith("/reports/transactions")) {
      await route.fulfill({
        json: {
          mode: "sandbox",
          from: now,
          to: now,
          summary: [
            { type: "collection", status: "succeeded", currency: "RWF", count: 1, amount_minor: 74500 }
          ],
          data: [transaction],
          has_more: false,
          next_cursor: null
        }
      });
      return;
    }
    if (path === "/transfers" && method === "GET") {
      await route.fulfill({
        json: { data: approved ? [] : [transfer], has_more: false, next_cursor: null }
      });
      return;
    }
    if (path === "/fraud/cases" && method === "GET") {
      await route.fulfill({
        json: { data: fraudResolved ? [{ ...fraudCase, status: "resolved" }] : [fraudCase] }
      });
      return;
    }
    if (path === "/reconciliation/imports" && method === "GET") {
      const item = {
        id: "imp_demo_1",
        status: reconciliationResolved ? "reconciled" : "needs_review",
        source_name: "Demo statement",
        line_count: 1,
        matched_count: reconciliationResolved ? 1 : 0,
        exception_count: reconciliationResolved ? 0 : 1,
        created_at: now
      };
      await route.fulfill({ json: { data: [item], has_more: false, next_cursor: null } });
      return;
    }
    if (path === "/collections" && method === "GET") {
      await route.fulfill({
        json: {
          data: [
            {
              id: "col_demo_1",
              status: "succeeded",
              currency: "RWF",
              reference: "ORDER-1042",
              description: "Sandbox order",
              amount: 50000,
              created_at: now
            }
          ],
          has_more: false,
          next_cursor: null
        }
      });
      return;
    }
    if (path === "/transaction-policies" && method === "GET") {
      await route.fulfill({ json: { data: [] } });
      return;
    }
    if (path === "/transfers/trf_demo_1/reject" && method === "POST") {
      approved = true;
      options.onRejected?.(request.postDataJSON(), request.headers()["idempotency-key"] ?? null);
      await route.fulfill({ json: { id: transfer.id, status: "rejected" } });
      return;
    }
    if (path === "/transfers/trf_demo_1/approve" && method === "POST") {
      approved = true;
      options.onApproved?.(request.postDataJSON(), request.headers()["idempotency-key"] ?? null);
      await route.fulfill({
        json: {
          id: transfer.id,
          status: "completed",
          approvals_received: 2,
          required_approvals: 2
        }
      });
      return;
    }
    if (path === "/reconciliation/imports/imp_demo_1" && method === "GET") {
      await route.fulfill({
        json: {
          id: "imp_demo_1",
          status: reconciliationResolved ? "reconciled" : "needs_review",
          source_name: "Demo statement",
          line_count: 1,
          lines: [
            reconciliationResolved
              ? {
                  ...reconciliationLine,
                  match_status: "matched",
                  collection_id: "col_demo_1"
                }
              : reconciliationLine
          ]
        }
      });
      return;
    }
    if (path === "/reconciliation/imports/imp_demo_1/lines/17/resolve" && method === "POST") {
      reconciliationResolved = true;
      options.onReconciliationResolved?.(request.postDataJSON());
      await route.fulfill({
        json: {
          import_id: "imp_demo_1",
          line_id: 17,
          match_status: "matched",
          collection_id: "col_demo_1"
        }
      });
      return;
    }
    if (path === "/fraud/cases/case_demo_1/resolve" && method === "POST") {
      fraudResolved = true;
      options.onFraudResolved?.(request.postDataJSON());
      await route.fulfill({ json: { id: fraudCase.id, status: "resolved" } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: `Unexpected mock API request: ${method} ${path}` } });
  });

  await page.goto("/");
  const loginLink = page.getByRole("link", { name: /^(Log in|Sign in)$/ });
  if (await loginLink.count()) {
    await loginLink.first().click();
  } else {
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  // Prove the client bundle is attached before typing into controlled inputs.
  await ensureHydratedPasswordToggle(page, "#password");
  await page.locator("#email").fill("avery@example.test");
  await page.locator("#password").fill("correct-horse-battery");
  await expect(page.locator("#email")).toHaveValue("avery@example.test");
  await expect(page.locator("#password")).toHaveValue("correct-horse-battery");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/app", { timeout: 15000 });
  await expect(page.locator('[data-app-hydrated="true"]')).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("heading", { name: "Recent transactions" })).toBeVisible();
}
