import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_TEST_BASE_URL ?? "http://127.0.0.1:3000";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  reporter: "list",
  use: {
    baseURL,
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"]
  },
  webServer: {
    command: `npm run dev -- --hostname 127.0.0.1 --port ${new URL(baseURL).port || "3000"}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
