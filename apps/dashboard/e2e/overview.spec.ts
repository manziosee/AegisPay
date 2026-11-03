import { expect, test } from "@playwright/test";
import { signInWithMockWorkspace } from "./helpers";

test("business user reviews the overview and searches ledger transactions", async ({ page }) => {
  await signInWithMockWorkspace(page);
  await expect(page.getByText("Transactions · 30 days")).toBeVisible();
  await expect(page.getByText("ORDER-1042")).toBeVisible();

  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("link", { name: "Transactions" })
    .click();
  await page.getByPlaceholder("Search reference, type, status…").fill("ORDER-1042");
  await expect(page.getByText("ORDER-1042")).toBeVisible();
  await page.getByPlaceholder("Search reference, type, status…").fill("missing");
  await expect(page.getByText("No matching transactions")).toBeVisible();
});

test("global search opens with Ctrl+K and jumps to a page", async ({ page }) => {
  await signInWithMockWorkspace(page);
  await page.keyboard.press("Control+k");
  await expect(page.getByPlaceholder("Search pages, actions and records")).toBeVisible();
  await page.getByPlaceholder("Search pages, actions and records").fill("risk");
  await page.getByRole("option", { name: /Risk review/ }).first().click();
  await expect(page).toHaveURL(/\/app\/intelligence/);
  await expect(page.getByRole("heading", { name: "Risk review" })).toBeVisible();
});
