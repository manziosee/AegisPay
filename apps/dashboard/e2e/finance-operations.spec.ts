import { expect, test } from "@playwright/test";
import { signInWithMockWorkspace } from "./helpers";

test("business staff create requests and import bank statements without claiming receipt", async ({ page }) => {
  let csvImport: Record<string, unknown> | undefined;
  await signInWithMockWorkspace(page);
  await page.route("**/proxy/v1/bank-operations/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/proxy/v1", "");
    if (path === "/bank-operations/requests" && request.method() === "GET") {
      await route.fulfill({ json: { data: [] } });
      return;
    }
    if (path === "/bank-operations/payouts" && request.method() === "GET") {
      await route.fulfill({ json: { data: [] } });
      return;
    }
    if (path === "/bank-operations/requests" && request.method() === "POST") {
      await route.fulfill({
        status: 201,
        json: { id: "req_test", reference: "AR-TEST-1", status: "open", settlement: "not_received" }
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: `Unexpected ${request.method()} ${path}` } });
  });
  await page.route("**/proxy/v1/reconciliation/imports/csv", async (route) => {
    csvImport = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ status: 201, json: { id: "imp_csv", matched_count: 1, exception_count: 0 } });
  });
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("link", { name: "Receive and send money" })
    .click();
  await page.getByLabel("Amount (major units)").nth(0).fill("12500");
  await page.getByLabel("Description").nth(0).fill("Shared costs");
  await page.getByRole("button", { name: "Create request" }).click();
  await expect(page.getByText("AR-TEST-1")).toBeVisible();
  await expect(page.getByText(/No funds have been received/)).toBeVisible();

  await page.getByLabel("Statement file").setInputFiles({
    name: "statement.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("reference,amount,currency,date\nAR-TEST-1,125.00,USD,2026-03-19\n")
  });
  await expect(page.getByText(/statement\.csv · CSV/)).toBeVisible();
  await page.getByRole("button", { name: "Import statement" }).click();
  await expect(page.getByText(/Statement imported\. 1 lines matched/)).toBeVisible();
  expect(csvImport?.source_name).toBe("statement.csv");
  expect(csvImport?.csv).toContain("AR-TEST-1");
});

test("payout register distinguishes export, bank submission, and settlement", async ({ page }) => {
  let payoutStatus = "prepared";
  await signInWithMockWorkspace(page);
  await page.route("**/proxy/v1/bank-operations/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/proxy/v1", "");
    if (path === "/bank-operations/requests" && request.method() === "GET") {
      await route.fulfill({ json: { data: [] } });
      return;
    }
    if (path === "/bank-operations/payouts" && request.method() === "GET") {
      await route.fulfill({
        json: {
          data: [
            {
              id: "pay_test",
              beneficiary_name: "Supplier A",
              amount: 5000,
              currency: "RWF",
              reference: "AP-TEST-1",
              description: "Office supplies",
              status: payoutStatus
            }
          ]
        }
      });
      return;
    }
    if (path === "/bank-operations/payouts" && request.method() === "POST") {
      await route.fulfill({
        status: 201,
        json: { id: "pay_test", reference: "AP-TEST-1", status: "prepared" }
      });
      return;
    }
    if (path === "/bank-operations/payouts/export" && request.method() === "POST") {
      payoutStatus = "exported_for_manual_entry";
      await route.fulfill({
        status: 200,
        contentType: "text/csv",
        body: "beneficiary_name,amount_minor,currency,reference,description\nSupplier A,5000,RWF,AP-TEST-1,Office supplies\n"
      });
      return;
    }
    if (path === "/bank-operations/payouts/pay_test/submit" && request.method() === "POST") {
      payoutStatus = "submitted_to_bank";
      await route.fulfill({
        json: { id: "pay_test", status: payoutStatus, settlement: "awaiting_bank_statement" }
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: `Unexpected ${request.method()} ${path}` } });
  });
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("link", { name: "Receive and send money" })
    .click();
  await page.getByLabel("Beneficiary").fill("Supplier A");
  await page.getByLabel("Amount (major units)").nth(1).fill("5000");
  await page.getByLabel("Description").nth(1).fill("Office supplies");
  await page.getByRole("button", { name: "Prepare payout" }).click();
  await page.getByRole("button", { name: "Export prepared CSV" }).click();
  await expect(page.getByText("exported for manual entry", { exact: true })).toBeVisible();
  await page.getByLabel("Bank submission note for AP-TEST-1").fill("Entered in bank portal by finance.");
  await page.getByRole("button", { name: "Record submitted" }).click();
  await expect(page.getByText("submitted to bank", { exact: true })).toBeVisible();
  await expect(page.getByText(/awaiting a statement match/)).toBeVisible();
});

test("payout approval count updates before bank-file export is available", async ({ page }) => {
  let approvalsReceived = 0;
  let payoutStatus = "pending_approval";
  const reviewNotes: string[] = [];
  await signInWithMockWorkspace(page);
  await page.route("**/proxy/v1/bank-operations/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/proxy/v1", "");
    if (path === "/bank-operations/requests" && request.method() === "GET") {
      await route.fulfill({ json: { data: [] } });
      return;
    }
    if (path === "/bank-operations/payouts" && request.method() === "GET") {
      await route.fulfill({
        json: {
          data: [
            {
              id: "pay_review",
              beneficiary_name: "Supplier B",
              amount: 150000000,
              currency: "RWF",
              reference: "AP-REVIEW-1",
              description: "Equipment",
              status: payoutStatus,
              approvals_received: approvalsReceived,
              required_approvals: 2
            }
          ]
        }
      });
      return;
    }
    if (path === "/bank-operations/payouts/pay_review/approve" && request.method() === "POST") {
      expect(request.headers()["idempotency-key"]).toBeTruthy();
      reviewNotes.push((request.postDataJSON() as { note: string }).note);
      approvalsReceived += 1;
      if (approvalsReceived === 2) payoutStatus = "prepared";
      await route.fulfill({
        json: {
          id: "pay_review",
          status: payoutStatus,
          approvals_received: approvalsReceived,
          required_approvals: 2
        }
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: `Unexpected ${request.method()} ${path}` } });
  });
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("link", { name: "Receive and send money" })
    .click();
  await expect(page.getByText("0 of 2 approvals")).toBeVisible();
  await page.getByLabel("Payout review note for AP-REVIEW-1").fill("Reviewed supplier invoice.");
  await page.getByRole("button", { name: "Approve payout" }).click();
  await expect(page.getByText("1 of 2 approvals")).toBeVisible();
  await expect(page.getByText("Payout approval recorded (1 of 2).")).toBeVisible();
  await page.getByLabel("Payout review note for AP-REVIEW-1").fill("Second reviewer agrees.");
  await page.getByRole("button", { name: "Approve payout" }).click();
  await expect(page.getByText("prepared", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Payout has all required approvals and is ready for register export.")
  ).toBeVisible();
  expect(reviewNotes).toEqual(["Reviewed supplier invoice.", "Second reviewer agrees."]);
});

test("owners close a reconciled period and record a safe scenario run", async ({ page }) => {
  let periodCreated = false;
  await signInWithMockWorkspace(page);
  await page.route("**/proxy/v1/bank-operations/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/proxy/v1", "");
    if (path === "/bank-operations/health" && request.method() === "GET") {
      await route.fulfill({
        json: {
          open_reconciliation_exceptions: 0,
          pending_approvals: 0,
          open_periods: Number(!periodCreated),
          payouts_awaiting_statement: 0
        }
      });
      return;
    }
    if (path === "/bank-operations/periods" && request.method() === "GET") {
      await route.fulfill({
        json: {
          data: periodCreated
            ? [
                {
                  id: "per_test",
                  period_start: "2026-02-01",
                  period_end: "2026-03-01",
                  status: "open",
                  close_note: ""
                }
              ]
            : []
        }
      });
      return;
    }
    if (path === "/bank-operations/periods" && request.method() === "POST") {
      periodCreated = true;
      await route.fulfill({ status: 201, json: { id: "per_test", status: "open" } });
      return;
    }
    if (path === "/bank-operations/periods/per_test/close" && request.method() === "POST") {
      await route.fulfill({ json: { id: "per_test", status: "closed" } });
      return;
    }
    if (path === "/bank-operations/scenarios/simulate" && request.method() === "POST") {
      await route.fulfill({
        status: 201,
        json: {
          id: "sim_test",
          result: { title: "Duplicate statement lines" },
          mode: "simulation_only",
          ledger_changed: false,
          funds_moved: false
        }
      });
      return;
    }
    if (path === "/bank-operations/delegations" && request.method() === "GET") {
      await route.fulfill({ json: { data: [] } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: `Unexpected ${request.method()} ${path}` } });
  });
  await page.route("**/proxy/v1/audit-logs?*", async (route) => {
    await route.fulfill({ json: { data: [] } });
  });
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("link", { name: "Close and controls" })
    .click();
  await page.getByLabel("Start date").fill("2026-02-01");
  await page.getByLabel("End date (exclusive)").fill("2026-03-01");
  await page.getByRole("button", { name: "Create checklist" }).click();
  await expect(page.getByText(/Feb 1, 2026/)).toBeVisible();
  await page.getByLabel("Review note for period 2026-02-01").fill("Reconciliation reviewed.");
  await page.getByRole("button", { name: "Close period" }).click();
  await expect(page.getByText("Period closed with a recorded review note.")).toBeVisible();
  await page.getByRole("button", { name: "Run simulation" }).click();
  await expect(page.getByText(/No ledger changes or funds movement occurred/)).toBeVisible();
});
