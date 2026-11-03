import { expect, test } from "@playwright/test";
import { signInWithMockWorkspace } from "./helpers";

test("finance operator matches a statement exception to a collection", async ({ page }) => {
  let resolution: unknown;
  await signInWithMockWorkspace(page, {
    role: "finance_operator",
    onReconciliationResolved: (body) => {
      resolution = body;
    }
  });

  const navigation = page.getByRole("navigation", { name: "Workspace navigation" });
  await expect(navigation.getByRole("link", { name: "Approvals" })).toHaveCount(0);
  await expect(navigation.getByRole("link", { name: "Risk review" })).toHaveCount(0);
  await navigation.getByRole("link", { name: "Reconciliation" }).click();
  await expect(page.getByRole("heading", { name: "Reconciliation" })).toBeVisible();
  await page.waitForTimeout(700);
  await page.getByRole("button", { name: /Demo statement/ }).click();
  await expect(page.getByText("BANK-REF-17")).toBeVisible();
  await page.getByRole("button", { name: "Link collection" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Match statement line")).toBeVisible();
  await dialog.getByRole("button", { name: /ORDER-1042/ }).click({ timeout: 10000 });
  await page.getByLabel("Resolution note").fill("Matched to the successful sandbox collection.");
  await page.getByRole("button", { name: "Confirm resolution" }).click();

  await expect(page.getByText("All lines resolved")).toBeVisible();
  expect(resolution).toEqual({
    resolution: "match",
    collection_id: "col_demo_1",
    note: "Matched to the successful sandbox collection."
  });
});
