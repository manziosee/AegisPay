import { expect, test } from "@playwright/test";
import { signInWithMockWorkspace } from "./helpers";

test("fraud analyst records a false-positive outcome and investigation note", async ({ page }) => {
  let decision: unknown;
  await signInWithMockWorkspace(page, {
    role: "fraud_analyst",
    onFraudResolved: (body) => {
      decision = body;
    }
  });

  const navigation = page.getByRole("navigation", { name: "Workspace navigation" });
  await expect(navigation.getByRole("link", { name: "Reconciliation" })).toHaveCount(0);
  await navigation.getByRole("link", { name: "Risk review" }).click();
  await expect(page.getByText("COL-REVIEW-9").first()).toBeVisible();
  await page.getByText("COL-REVIEW-9").first().click();
  await page
    .getByLabel("Investigation note")
    .fill("Reviewed account history; activity is expected for this customer.");
  await page.getByRole("button", { name: "False positive" }).click();

  await expect(page.getByText("No open cases")).toBeVisible();
  expect(decision).toEqual({
    outcome: "false_positive",
    note: "Reviewed account history; activity is expected for this customer."
  });
});
