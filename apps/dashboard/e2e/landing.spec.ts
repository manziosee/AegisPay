import { expect, test } from "@playwright/test";
import { ensureHydratedPasswordToggle } from "./helpers";

test("public landing explains AegisPay and links to sign-in and sandbox registration", async ({ page }) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: /the ledger, risk and approval trail/i })
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Marketing navigation" }).getByRole("button", {
      name: "Product"
    })
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sandbox boundaries" })).toBeVisible();
  await expect(page.getByText("No external execution")).toBeVisible();
  await expect(page.getByText(/Ledger, risk and approval records for business/i)).toBeVisible();

  await page.getByRole("link", { name: "Log in" }).click();
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await page.getByRole("link", { name: "Back to AegisPay" }).click();

  await page.getByRole("link", { name: "Create sandbox account" }).first().click();
  await expect(page.getByRole("heading", { name: "Create your workspace" })).toBeVisible();
  await expect(page.getByLabel("Organization name")).toBeVisible();
});

test("landing page fits a mobile viewport without horizontal scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: /the ledger, risk and approval trail/i })
  ).toBeVisible();
  const pageWidth = await page.locator("body").evaluate((body) => body.scrollWidth);
  expect(pageWidth).toBeLessThanOrEqual(390);
});

test("individuals can choose a personal workspace without an organization name", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Create sandbox account" }).first().click();
  await expect(page.getByRole("heading", { name: "Create your workspace" })).toBeVisible();
  // The visibility toggle only responds once the client component has hydrated.
  await ensureHydratedPasswordToggle(page, "#register-password");
  await page.getByRole("radio", { name: "Personal" }).click();
  await expect(page.getByRole("radio", { name: "Personal" })).toHaveAttribute(
    "aria-checked",
    "true"
  );
  await expect(page.getByLabel("Organization name")).toHaveCount(0);
  await expect(page.getByLabel("Full name")).toBeVisible();
  await expect(page.getByLabel("Work email")).toBeVisible();
});

test("browser-extension attributes on body do not cause hydration warnings", async ({ page }) => {
  const hydrationWarnings: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && message.text().includes("hydrated but some attributes")) {
      hydrationWarnings.push(message.text());
    }
  });
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      document.body.setAttribute("data-new-gr-c-s-check-loaded", "14.1344.0");
      document.body.setAttribute("data-gr-ext-installed", "");
    });
  });

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /the ledger, risk and approval trail/i })
  ).toBeVisible();
  await expect.poll(() => hydrationWarnings).toHaveLength(0);
});
