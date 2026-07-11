import { defineConfig } from "@playwright/test";

/**
 * Playwright configuration for the Electron end-to-end test suite.
 * See https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  // Electron apps generally don't tolerate multiple instances well, so keep
  // the suite serial by default. Bump this once the suite is parallel-safe.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  // CI gets a retry cushion for the suite's inherent timing sensitivity
  // (real installers, watchdogs, slow runners). MIMIRI_RETRIES overrides it:
  // the scheduled CI run sets 0 so genuine races fail loudly there instead
  // of hiding as retry-passes (the HTML report marks those "flaky").
  retries: process.env.MIMIRI_RETRIES
    ? Number(process.env.MIMIRI_RETRIES)
    : process.env.CI
      ? 2
      : 0,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
});
