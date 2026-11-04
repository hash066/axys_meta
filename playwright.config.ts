import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  expect: { timeout: 20000 },
  use: {
    baseURL: "http://127.0.0.1:4310",
    trace: "retain-on-failure",
    channel: process.env.PLAYWRIGHT_CHANNEL || "chrome",
  },
  webServer: {
    command: "node --import tsx server/index.ts",
    url: "http://127.0.0.1:4310/health",
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
});
