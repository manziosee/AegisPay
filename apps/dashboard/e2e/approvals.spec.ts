import { expect, test } from "@playwright/test";
import { signInWithMockWorkspace } from "./helpers";

test("admin approves a pending internal transfer with an idempotency key", async ({ page }) => {
  let approvalKey: string | null = null;
  await signInWithMockWorkspace(page, {
    onApproved: (_body, key) => {
      approvalKey = key;
    }
  });

  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("link", { name: "Approvals" })
    .click();
  await expect(page.getByRole("heading", { name: "Transfer approvals" })).toBeVisible();
  await page.waitForTimeout(700);
  await expect(page.getByText("PAYROLL-NOV")).toBeVisible();
  await page.getByRole("row", { name: /PAYROLL-NOV/ }).click();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Approve", exact: true }).click();

  await expect(page.getByText("Approval queue is clear")).toBeVisible();
  expect(approvalKey).toMatch(/^dash_/);
});

test("rejecting a transfer requires a recorded reason", async ({ page }) => {
  let rejectBody: unknown = null;
  let rejectKey: string | null = null;
  await signInWithMockWorkspace(page, {
    onRejected: (body, key) => {
      rejectBody = body;
      rejectKey = key;
    }
  });

  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("link", { name: "Approvals" })
    .click();
  await page.waitForTimeout(700);
  await expect(page.getByText("PAYROLL-NOV")).toBeVisible();
  await page.getByRole("row", { name: /PAYROLL-NOV/ }).click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Reject", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "Reject transfer" });
  await expect(dialog).toBeVisible();
  const submit = dialog.getByRole("button", { name: "Reject transfer" });
  await expect(submit).toBeDisabled();
  await dialog.getByLabel("Reason").fill("Beneficiary is not on the approved vendor list");
  await submit.click();

  await expect(dialog).toBeHidden();
  expect(rejectBody).toEqual({ note: "Beneficiary is not on the approved vendor list" });
  expect(rejectKey).toMatch(/^dash_/);
});
