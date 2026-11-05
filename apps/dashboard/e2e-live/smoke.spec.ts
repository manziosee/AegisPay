import { createHmac } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

/**
 * Live smoke test: drives a real dashboard against a real API (no mocks).
 * It creates a fresh sandbox workspace, so it is safe to run against the
 * hosted sandbox. Run with:
 *   LIVE_BASE_URL=https://aegispays.netlify.app npm run test:live
 */

function totp(secret: string, at = Date.now()) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret.replace(/=+$/, "")) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

async function go(page: Page, label: string, heading: string | RegExp) {
  await page.getByRole("navigation", { name: "Workspace navigation" }).getByRole("link", { name: label }).click();
  await expect(page.getByRole("heading", { name: heading, level: 1 })).toBeVisible();
}

async function dialog(page: Page, title: string) {
  const element = page.getByRole("dialog", { name: title });
  await expect(element).toBeVisible();
  return element;
}

test.describe.configure({ mode: "serial" });

test("a new business can run its core money workflows end to end", async ({ page }) => {
  test.setTimeout(240_000);
  const id = Date.now().toString(36);
  const email = `smoke-${id}@example.com`;

  await test.step("register a workspace", async () => {
    await page.goto("/register");
    await page.getByLabel("Full name").fill("Smoke Tester");
    await page.getByLabel("Organization name").fill(`Smoke ${id}`);
    await page.getByLabel("Country (two-letter code)").fill("DE");
    await page.getByLabel("Work email").fill(email);
    await page.locator("#register-password").fill("correct-horse-battery");
    await page.getByRole("button", { name: /Create account/ }).click();
    await page.waitForURL(/\/app/);
    await expect(page.getByRole("button", { name: "Switch workspace" })).toContainText(`Smoke ${id}`);
  });

  await test.step("add a customer", async () => {
    await go(page, "Customers", "Customers");
    await page.getByRole("button", { name: "Add customer" }).click();
    const form = await dialog(page, "Add a customer");
    await form.getByLabel("Name").fill("Ada Lovelace");
    await form.getByLabel("Email (optional)").fill(`ada-${id}@example.com`);
    await form.getByRole("button", { name: "Add customer" }).click();
    await expect(page.getByRole("cell", { name: "Ada Lovelace" })).toBeVisible();
  });

  await test.step("create two EUR accounts and credit one", async () => {
    await go(page, "Accounts", "Accounts");
    for (let i = 0; i < 2; i++) {
      await page.getByRole("button", { name: "Create account" }).first().click();
      const form = await dialog(page, "Create a currency account");
      await form.getByLabel("Currency code").fill("EUR");
      await form.getByRole("button", { name: "Create account" }).click();
      await expect(form).toBeHidden();
    }
    await expect(page.getByRole("button", { name: "Sandbox credit" })).toHaveCount(2);
    await page.getByRole("button", { name: "Sandbox credit" }).first().click();
    const credit = await dialog(page, "Add a sandbox credit");
    await credit.getByLabel(/Amount/).fill("500");
    await credit.getByRole("button", { name: "Post credit" }).click();
    await expect(page.getByText("€500.00 credited.")).toBeVisible();
  });

  await test.step("collect, confirm and refund a payment", async () => {
    await go(page, "Collections and transfers", "Collections and transfers");
    await page.getByRole("button", { name: "New collection" }).click();
    const form = await dialog(page, "Create a collection");
    await form.getByLabel("Amount").fill("120");
    await form.getByLabel("Currency").fill("EUR");
    await form.getByLabel("Reference").fill(`INV-${id}`);
    await form.getByLabel("Customer (optional)").selectOption({ label: "Ada Lovelace" });
    await form.getByRole("button", { name: "Create collection" }).click();
    const row = page.getByRole("row", { name: new RegExp(`INV-${id}`) });
    await row.getByRole("button", { name: "Confirm" }).click();
    const confirm = await dialog(page, "Confirm a collection");
    await confirm.getByRole("button", { name: "Confirm and post" }).click();
    await expect(row).toContainText(/succeeded/i);
    await row.getByRole("button", { name: "Refund" }).click();
    const refund = await dialog(page, "Refund a collection");
    await refund.getByLabel(/Amount/).fill("20");
    await refund.getByRole("button", { name: "Post refund" }).click();
    await expect(page.getByText("Refund posted.")).toBeVisible();
  });

  await test.step("transfer between accounts", async () => {
    await page.getByRole("button", { name: "New transfer" }).click();
    const form = await dialog(page, "Transfer between accounts");
    const from = form.getByLabel("From account");
    await from.selectOption({ index: 1 });
    await form.getByLabel("To account").selectOption({ index: 1 });
    await form.getByLabel(/Amount/).fill("50");
    await form.getByRole("button", { name: "Transfer" }).click();
    await expect(page.getByText("Transfer completed.")).toBeVisible();
  });

  await test.step("create, rotate and revoke an API key", async () => {
    await go(page, "API keys", "API keys");
    await page.getByRole("button", { name: "Create API key" }).click();
    const form = await dialog(page, "Create an API key");
    await form.getByLabel("Name").fill("Smoke key");
    await form.getByRole("button", { name: "Create key" }).click();
    const secretDialog = await dialog(page, "Copy your secret now");
    await expect(secretDialog.locator("code")).toHaveText(/^aegis_test_[0-9a-f]{32}$/);
    await secretDialog.getByRole("button", { name: "I have stored it" }).click();
    await page.getByRole("button", { name: "Rotate" }).click();
    await (await dialog(page, "Rotate Smoke key")).getByRole("button", { name: "Rotate key" }).click();
    await (await dialog(page, "Copy your secret now")).getByRole("button", { name: "I have stored it" }).click();
    await page.getByRole("button", { name: "Revoke" }).click();
    await (await dialog(page, "Revoke Smoke key")).getByRole("button", { name: "Revoke key" }).click();
    await expect(page.getByText("0 active")).toBeVisible();
  });

  await test.step("register a webhook endpoint", async () => {
    await go(page, "Webhooks", "Webhooks");
    await page.getByRole("button", { name: "Add endpoint" }).click();
    const form = await dialog(page, "Add a webhook endpoint");
    await form.getByLabel("Endpoint URL").fill("https://example.com/aegispay-smoke");
    await form.getByRole("button", { name: "Add endpoint" }).click();
    const secretDialog = await dialog(page, "Copy the signing secret");
    await expect(secretDialog.locator("code")).toHaveText(/^[0-9a-f]{64}$/);
    await secretDialog.getByRole("button", { name: "I have stored it" }).click();
    await expect(page.getByText("https://example.com/aegispay-smoke")).toBeVisible();
  });

  await test.step("turn on authenticator MFA", async () => {
    await go(page, "Organization settings", /settings/i);
    await page.getByRole("button", { name: "Turn on" }).click();
    const setup = await dialog(page, "Set up your authenticator app");
    const secret = (await setup.locator("code").textContent())?.trim() ?? "";
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    await setup.getByLabel("Six-digit code").fill(totp(secret));
    await setup.getByRole("button", { name: "Verify and turn on" }).click();
    await expect(page.getByText(/^On since/)).toBeVisible();
  });

  await test.step("create and switch workspaces", async () => {
    await page.getByRole("button", { name: "Switch workspace" }).click();
    await page.getByRole("menuitem", { name: "Create workspace" }).click();
    const form = await dialog(page, "Create a workspace");
    await form.getByLabel("Name").fill(`Second ${id}`);
    await form.getByLabel("Country code").fill("KE");
    await form.getByRole("button", { name: "Create workspace" }).click();
    await expect(page.getByRole("button", { name: "Switch workspace" })).toContainText(`Second ${id}`);
    await page.getByRole("button", { name: "Switch workspace" }).click();
    await page.getByRole("menuitem", { name: new RegExp(`Smoke ${id}`) }).click();
    await expect(page.getByRole("button", { name: "Switch workspace" })).toContainText(`Smoke ${id}`);
  });
});

test("risk rules, developer tools, sessions and audit integrity work end to end", async ({ page }) => {
  test.setTimeout(240_000);
  const id = Date.now().toString(36);

  await test.step("register a workspace with two funded accounts", async () => {
    await page.goto("/register");
    await page.getByLabel("Full name").fill("Rules Tester");
    await page.getByLabel("Organization name").fill(`Rules ${id}`);
    await page.getByLabel("Country (two-letter code)").fill("CA");
    await page.getByLabel("Work email").fill(`rules-${id}@example.com`);
    await page.locator("#register-password").fill("correct-horse-battery");
    await page.getByRole("button", { name: /Create account/ }).click();
    await page.waitForURL(/\/app/);
    await go(page, "Accounts", "Accounts");
    for (let i = 0; i < 2; i++) {
      await page.getByRole("button", { name: "Create account" }).first().click();
      const form = await dialog(page, "Create a currency account");
      await form.getByLabel("Currency code").fill("CAD");
      await form.getByRole("button", { name: "Create account" }).click();
      await expect(form).toBeHidden();
    }
    await page.getByRole("button", { name: "Sandbox credit" }).first().click();
    const credit = await dialog(page, "Add a sandbox credit");
    await credit.getByLabel(/Amount/).fill("10000");
    await credit.getByRole("button", { name: "Post credit" }).click();
    await expect(page.getByText(/credited\./)).toBeVisible();
  });

  await test.step("create a block rule and dry-run it", async () => {
    await go(page, "Risk rules", "Risk rules");
    await page.getByRole("button", { name: "New rule" }).click();
    const form = await dialog(page, "New risk rule");
    await form.getByLabel("Name").fill("Block large CAD transfers");
    await form.getByLabel("Currency").fill("CAD");
    await form.getByLabel("Min amount").fill("1000");
    await form.getByLabel("Action").selectOption("block");
    await form.getByRole("button", { name: "Create rule" }).click();
    await expect(page.getByText("Block large CAD transfers")).toBeVisible();
    await page.locator("#test-amount").fill("2500");
    await page.locator("#test-currency").fill("CAD");
    await page.getByRole("button", { name: "Evaluate" }).click();
    await expect(page.getByRole("status")).toContainText(/block/i);
  });

  await test.step("the rule blocks a real transfer", async () => {
    await go(page, "Collections and transfers", "Collections and transfers");
    await page.getByRole("button", { name: "New transfer" }).click();
    const form = await dialog(page, "Transfer between accounts");
    await form.getByLabel("From account").selectOption({ index: 1 });
    await form.getByLabel("To account").selectOption({ index: 1 });
    await form.getByLabel(/Amount/).fill("2500");
    await form.getByRole("button", { name: "Transfer" }).click();
    await expect(form.getByRole("alert")).toContainText("blocked by risk rule: Block large CAD transfers");
    await form.getByLabel(/Amount/).fill("50");
    await form.getByRole("button", { name: "Transfer" }).click();
    await expect(page.getByText("Transfer completed.")).toBeVisible();
  });

  await test.step("webhook test event and event log", async () => {
    await go(page, "Webhooks", "Webhooks");
    await page.getByRole("button", { name: "Add endpoint" }).click();
    const form = await dialog(page, "Add a webhook endpoint");
    await form.getByLabel("Endpoint URL").fill("https://example.com/aegispay-rules");
    await form.getByRole("button", { name: "Add endpoint" }).click();
    await (await dialog(page, "Copy the signing secret")).getByRole("button", { name: "I have stored it" }).click();
    await page.getByRole("button", { name: "Send test" }).click();
    await expect(page.getByText("Test event queued.")).toBeVisible();
    await expect(page.getByText("transfer.completed").first()).toBeVisible();
    await page.getByRole("button", { name: "Replay" }).first().click();
    await expect(page.getByText(/Queued \d+ deliver|No active endpoint/)).toBeVisible();
    await page.getByRole("button", { name: "Rotate secret" }).click();
    await (await dialog(page, "Rotate signing secret")).getByRole("button", { name: "Rotate secret" }).click();
    await expect((await dialog(page, "Copy the signing secret")).locator("code")).toHaveText(/^[0-9a-f]{64}$/);
  });

  await test.step("sessions and audit integrity", async () => {
    await page.keyboard.press("Escape");
    await go(page, "Organization settings", /settings/i);
    await expect(page.getByText("This device")).toBeVisible();
    await go(page, "Close and controls", /close/i);
    await page.getByRole("button", { name: "Verify integrity" }).click();
    await expect(page.getByText(/Audit trail intact: \d+ records verified/)).toBeVisible();
  });
});

test("statement files, chat notifications, password reset and invitations work end to end", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const id = Date.now().toString(36);
  const ownerEmail = `owner-${id}@example.com`;
  const inviteeEmail = `invitee-${id}@example.com`;

  await test.step("owner registers and records a confirmed collection", async () => {
    await page.goto("/register");
    await page.getByLabel("Full name").fill("Owner Tester");
    await page.getByLabel("Organization name").fill(`Batch ${id}`);
    await page.getByLabel("Country (two-letter code)").fill("NL");
    await page.getByLabel("Work email").fill(ownerEmail);
    await page.locator("#register-password").fill("correct-horse-battery");
    await page.getByRole("button", { name: /Create account/ }).click();
    await page.waitForURL(/\/app/);
    await go(page, "Accounts", "Accounts");
    await page.getByRole("button", { name: "Create account" }).first().click();
    const form = await dialog(page, "Create a currency account");
    await form.getByLabel("Currency code").fill("EUR");
    await form.getByRole("button", { name: "Create account" }).click();
    await expect(form).toBeHidden();
    await go(page, "Collections and transfers", "Collections and transfers");
    await page.getByRole("button", { name: "New collection" }).click();
    const col = await dialog(page, "Create a collection");
    await col.getByLabel("Amount").fill("75");
    await col.getByLabel("Currency").fill("EUR");
    await col.getByLabel("Reference").fill(`CAMT-${id}`);
    await col.getByRole("button", { name: "Create collection" }).click();
    const row = page.getByRole("row", { name: new RegExp(`CAMT-${id}`) });
    await row.getByRole("button", { name: "Confirm" }).click();
    await (await dialog(page, "Confirm a collection")).getByRole("button", { name: "Confirm and post" }).click();
    await expect(row).toContainText(/succeeded/i);
  });

  await test.step("import a CAMT.053 statement file", async () => {
    await go(page, "Receive and send money", /send money|receive/i);
    const camt = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt><Stmt><Ntry><Amt Ccy="EUR">75.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>2026-01-15</Dt></BookgDt><NtryDtls><TxDtls><RmtInf><Ustrd>CAMT-${id}</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry></Stmt></BkToCstmrStmt></Document>`;
    await page.locator("#statement-csv").setInputFiles({ name: "statement.xml", mimeType: "application/xml", buffer: Buffer.from(camt) });
    await expect(page.getByText("CAMT.053 (ISO 20022)").first()).toBeVisible();
    await page.getByRole("button", { name: "Import statement" }).click();
    await expect(page.getByText(/Statement imported\. 1 lines matched; 0 need review\./)).toBeVisible();
  });

  await test.step("add a chat channel and see the platform's answer", async () => {
    await go(page, "Webhooks", "Webhooks");
    await page.getByRole("button", { name: "Add channel" }).click();
    const form = await dialog(page, "Add a chat channel");
    await form.getByLabel("Chat app").selectOption("discord");
    await form.getByLabel("Webhook URL").fill("https://discord.com/api/webhooks/1/smoke-test-not-real");
    await form.getByLabel("Name (optional)").fill("Finance alerts");
    await form.getByRole("button", { name: "Add and send test" }).click();
    await expect(page.getByText("Finance alerts")).toBeVisible();
    await expect(page.getByText(/Last error: Discord returned HTTP/)).toBeVisible();
  });

  await test.step("invite a teammate who signs up from the link and joins", async () => {
    await go(page, "Team access", /team/i);
    const invitation = await page.evaluate(async (address) => {
      const response = await fetch("/proxy/v1/invitations", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Organization-ID": localStorage.getItem("aegispay.organization") ?? "" },
        body: JSON.stringify({ email: address, role: "auditor" })
      });
      return response.json();
    }, inviteeEmail);
    expect(invitation.invite_token).toMatch(/^aegis_invite_/);
    const organization = await page.evaluate(() => localStorage.getItem("aegispay.organization"));
    const link = `/invite?invitation=${invitation.id}&organization=${organization}&token=${invitation.invite_token}`;

    const invitee = await browser.newPage();
    await invitee.goto(link);
    await invitee.getByRole("link", { name: "Create an account" }).click();
    await invitee.getByLabel("Full name").fill("Invited Auditor");
    await invitee.getByLabel("Organization name").fill(`Own ${id}`);
    await invitee.getByLabel("Country (two-letter code)").fill("NL");
    await invitee.getByLabel("Work email").fill(inviteeEmail);
    await invitee.locator("#register-password").fill("correct-horse-battery");
    await invitee.getByRole("button", { name: /Create account/ }).click();
    await invitee.waitForURL(/\/invite\?/);
    await invitee.getByRole("button", { name: "Accept invitation" }).click();
    await invitee.waitForURL(/\/app$/);
    await expect(invitee.getByRole("button", { name: "Switch workspace" })).toContainText(`Batch ${id}`);
    await invitee.close();
  });

  await test.step("forgot password never reveals whether an account exists", async () => {
    await page.context().clearCookies();
    await page.goto("/login");
    await page.getByRole("link", { name: "Forgot password?" }).click();
    await page.getByLabel("Account email").fill(ownerEmail);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByText(/If an account uses .* a reset link is on its way/)).toBeVisible();
    await page.goto("/reset-password");
    await expect(page.getByText("This page needs the link from your reset email.")).toBeVisible();
  });
});
