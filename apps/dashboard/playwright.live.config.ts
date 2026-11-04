import { defineConfig, devices } from "@playwright/test";

// Runs e2e-live against an already running dashboard and API (no mocks).
const baseURL = process.env.LIVE_BASE_URL ?? "http://127.0.0.1:3000";

export default defineConfig({
  testDir: "./e2e-live",
  reporter: "list",
  retries: 0,
  use: {
    baseURL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"]
  }
});
