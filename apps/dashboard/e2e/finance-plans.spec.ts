import { expect, test, type Page } from "@playwright/test";
import { signInWithMockWorkspace } from "./helpers";

const fund = {
  id: "fnd_demo",
  name: "Field programme grant",
  fund_type: "grant",
  donor_name: "Community Fund",
  project_code: "FIELD-01",
  restriction_note: "Travel and community supplies only",
  currency: "RWF",
  allocated_minor: 500000,
  committed_minor: 0,
  spent_minor: 0,
  available_minor: 500000,
  period_start: "2026-01-01",
  period_end: "2026-12-31",
  status: "active",
  created_at: "2026-01-01T00:00:00Z"
};

async function openFinance(page: Page) {
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("link", { name: "Funds and budgets" })
    .click();
  await expect(page.getByRole("heading", { name: "Funds and budgets" })).toBeVisible();
}

test("reserves a commitment and links it to bank payout approval without claiming settlement", async ({ page }) => {
  const commitments: Record<string, unknown>[] = [];
  let linked = false;
  await signInWithMockWorkspace(page);
  await page.route("**/proxy/v1/finance-plans/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/proxy/v1", "");
    if (path === "/finance-plans/funds" && request.method() === "GET") {
      await route.fulfill({ json: { data: [fund] } });
      return;
    }
    if (path === "/finance-plans/commitments" && request.method() === "GET") {
      await route.fulfill({ json: { data: commitments.map((item) => ({ ...item, status: linked ? "linked" : "planned", payout_id: linked ? "pay_demo" : null })) } });
      return;
    }
    if (path === "/finance-plans/advances" && request.method() === "GET") {
      await route.fulfill({ json: { data: [] } });
      return;
    }
    if (path === "/finance-plans/queue" && request.method() === "GET") {
      await route.fulfill({ json: { data: [] } });
      return;
    }
    if (path === "/finance-plans/evidence" && request.method() === "GET") {
      await route.fulfill({ json: { data: [] } });
      return;
    }
    if (path === "/finance-plans/commitments" && request.method() === "POST") {
      expect(request.headers()["idempotency-key"]).toBeTruthy();
      const payload = request.postDataJSON() as Record<string, unknown>;
      expect(payload.amount_minor).toBe(125000);
      commitments.push({ ...payload, id: "cmt_demo", fund_name: fund.name, created_at: "2026-11-03T12:00:00Z" });
      await route.fulfill({ status: 201, json: { id: "cmt_demo", status: "planned" } });
      return;
    }
    if (path === "/finance-plans/commitments/cmt_demo/link-payout" && request.method() === "POST") {
      linked = true;
      await route.fulfill({ status: 201, json: { payout_id: "pay_demo", status: "pending_approval", settlement: "not_submitted" } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: `Unexpected ${request.method()} ${path}` } });
  });
  await openFinance(page);

  await page.locator("#commitment-title").fill("Field equipment");
  await page.locator("#commitment-beneficiary").fill("Kivu Supplies");
  await page.locator("#commitment-amount").fill("125000");
  await page.getByRole("button", { name: "Reserve commitment" }).click();
  await expect(page.getByText("Field equipment")).toBeVisible();
  await page.getByRole("button", { name: "Send to payout approvals" }).click();
  await expect(page.getByText("Payout: linked")).toBeVisible();
  await expect(page.getByText(/not marked paid until matched in a bank statement/)).toBeVisible();
});

test("stores an offline commitment locally and syncs it with the original idempotency key", async ({ page }) => {
  let synced = false;
  let syncKey = "";
  await signInWithMockWorkspace(page);
  await page.route("**/proxy/v1/finance-plans/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/proxy/v1", "");
    if (path === "/finance-plans/funds" && request.method() === "GET") {
      await route.fulfill({ json: { data: [fund] } });
      return;
    }
    if (path === "/finance-plans/commitments" && request.method() === "GET") {
      await route.fulfill({ json: { data: synced ? [{ id: "cmt_synced", fund_id: fund.id, fund_name: fund.name, commitment_type: "operating", title: "Offline supplies", beneficiary_name: "", amount_minor: 90000, currency: "RWF", status: "planned", payout_id: null, due_date: null }] : [] } });
      return;
    }
    if (path === "/finance-plans/advances" && request.method() === "GET" || path === "/finance-plans/queue" && request.method() === "GET") {
      await route.fulfill({ json: { data: [] } });
      return;
    }
    if (path === "/finance-plans/commitments" && request.method() === "POST") {
      synced = true;
      syncKey = request.headers()["idempotency-key"] ?? "";
      await route.fulfill({ status: 201, json: { id: "cmt_synced" } });
      return;
    }
    if (path === "/finance-plans/evidence" && request.method() === "GET") {
      await route.fulfill({ json: { data: [] } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: `Unexpected ${request.method()} ${path}` } });
  });
  await openFinance(page);

  await page.context().setOffline(true);
  await page.locator("#commitment-title").fill("Offline supplies");
  await page.locator("#commitment-amount").fill("90000");
  await page.getByRole("button", { name: "Reserve commitment" }).click();
  await expect(page.getByText("Offline drafts · 1")).toBeVisible();
  await expect(page.getByText(/does not reserve server budget until sync succeeds/)).toBeVisible();

  await page.context().setOffline(false);
  await expect.poll(() => synced).toBe(true);
  await expect(page.getByText("Offline supplies")).toBeVisible();
  await expect(page.getByText("Offline drafts · 1")).toHaveCount(0);
  expect(synced).toBe(true);
  expect(syncKey).toMatch(/^dash_/);
});

test("requires a bank statement before advance settlement and queues it for an independent reviewer", async ({ page }) => {
  const advance = {
    id: "adv_demo",
    commitment_id: "cmt_adv",
    payout_id: "pay_adv",
    staff_name: "Avery Field",
    purpose: "Field travel",
    amount_minor: 100000,
    currency: "RWF",
    status: "outstanding",
    fund_id: fund.id,
    fund_name: fund.name,
    payout_reference: "AA-ADVANCE-1",
    payout_status: "statement_confirmed",
    settled_minor: 0,
    used_minor: 0,
    remaining_minor: 100000,
    created_at: "2026-11-01T12:00:00Z"
  };
  let settlementStatus = "";
  let advanceSettled = false;
  let settlementEvidenceAttached = false;
  await signInWithMockWorkspace(page);
  await page.route("**/proxy/v1/finance-plans/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/proxy/v1", "");
    if (path === "/finance-plans/funds" && request.method() === "GET") {
      await route.fulfill({ json: { data: [fund] } });
      return;
    }
    if (path === "/finance-plans/commitments" && request.method() === "GET") {
      await route.fulfill({ json: { data: [] } });
      return;
    }
    if (path === "/finance-plans/advances" && request.method() === "GET") {
      await route.fulfill({ json: { data: [{ ...advance, status: advanceSettled ? "settled" : "outstanding", remaining_minor: advanceSettled ? 0 : 100000, used_minor: advanceSettled ? 60000 : 0, settled_minor: advanceSettled ? 100000 : 0 }] } });
      return;
    }
    if (path === "/finance-plans/queue" && request.method() === "GET") {
      await route.fulfill({ json: { data: settlementStatus === "pending_review" ? [{ id: "stl_demo", advance_id: advance.id, type: "advance_settlement", reference: advance.staff_name, amount_minor: 100000, currency: "RWF", status: settlementStatus, reason: "Staff advance settlement needs an independent review", priority: 2 }] : [] } });
      return;
    }
    if (path === `/finance-plans/advances/${advance.id}/settlements` && request.method() === "GET") {
      await route.fulfill({ json: { data: settlementStatus ? [{ id: "stl_demo", advance_id: advance.id, used_minor: 60000, returned_minor: 40000, note: "Receipts attached; balance returned", status: settlementStatus, submitted_by: "usr_demo", reviewed_by: settlementStatus === "approved" ? "usr_reviewer" : null, reviewed_at: null, created_at: "2026-11-03T12:00:00Z" }] : [] } });
      return;
    }
    if (path === `/finance-plans/advances/${advance.id}/settlements` && request.method() === "POST") {
      expect(request.headers()["idempotency-key"]).toBeTruthy();
      const payload = request.postDataJSON() as { used_minor: number; returned_minor: number };
      expect(payload).toEqual({ used_minor: 60000, returned_minor: 40000, note: "Receipts attached; balance returned" });
      settlementStatus = "pending_review";
      await route.fulfill({ status: 201, json: { id: "stl_demo", status: settlementStatus } });
      return;
    }
    if (path === `/finance-plans/advances/${advance.id}/settlements/stl_demo/review` && request.method() === "POST") {
      expect((request.postDataJSON() as { decision: string }).decision).toBe("approve");
      settlementStatus = "approved";
      advanceSettled = true;
      await route.fulfill({ status: 200, json: { id: "stl_demo", status: settlementStatus } });
      return;
    }
    if (path === "/finance-plans/evidence" && request.method() === "GET") {
      await route.fulfill({
        json: {
          data: settlementEvidenceAttached
            ? [{ id: "ev_demo", file_name: "field-receipt.pdf", file_size: 128, created_at: "2026-11-03T12:00:00Z" }]
            : []
        }
      });
      return;
    }
    if (path === "/finance-plans/evidence" && request.method() === "POST") {
      const payload = request.postDataBuffer()?.toString("utf8") ?? "";
      expect(request.headers()["content-type"]).toContain("multipart/form-data");
      expect(payload).toContain("settlement");
      expect(payload).toContain("stl_demo");
      settlementEvidenceAttached = true;
      await route.fulfill({ status: 201, json: { id: "ev_demo" } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: `Unexpected ${request.method()} ${path}` } });
  });
  await openFinance(page);

  await expect(page.getByText("Outstanding RWF 100,000")).toBeVisible();
  await page.getByLabel("Amount used").fill("60000");
  await page.getByLabel("Amount returned").fill("40000");
  await page.getByLabel("Settlement explanation").fill("Receipts attached; balance returned");
  await page.getByRole("button", { name: "Submit for review" }).click();
  await expect(page.getByText("A settlement is awaiting independent review.")).toBeVisible();
  const settlementEvidenceInput = page.getByLabel("Evidence file for stl_demo");
  await settlementEvidenceInput.setInputFiles({ name: "field-receipt.pdf", mimeType: "application/pdf", buffer: Buffer.from("sample receipt") });
  const settlementEvidenceForm = page.locator("form").filter({ has: settlementEvidenceInput });
  await settlementEvidenceForm.getByRole("button", { name: "Attach" }).click();
  await expect(page.getByText("field-receipt.pdf")).toBeVisible();
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("approved", { exact: true })).toBeVisible();
  await expect(page.getByText("Outstanding RWF 0")).toBeVisible();
});
