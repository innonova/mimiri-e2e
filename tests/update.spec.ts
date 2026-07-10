import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";
import {
  launchApp,
  cleanup,
  loadMeta,
  getTestInfo,
  supportsUpdateSeams,
  AppContext,
} from "../helpers/app";
import { enterLocalMode } from "../helpers/ui";
import { startUpdateServer, TestUpdateServer } from "../helpers/update-server";

/**
 * Exercises a real bundle update end to end: a local mock of
 * update.mimiri.io serves the published bundle the artifact was tested
 * against, version-bumped to 99.0.0 and re-signed with a per-run test key.
 * The app is pointed at the mock via the MIMIRI_UPDATE_URL /
 * MIMIRI_UPDATE_KEY seams (client 2.6.9+) and the flow is driven through
 * the real Settings → Updates UI: check → download (signature verify,
 * install) → activate (window reload) → the app runs the new bundle.
 *
 * Runs on Linux (targz) and Windows. macOS needs native-menu navigation and
 * the other Linux formats are follow-up work (flatpak/snap store update
 * flows are out of scope by design).
 */

/** macOS is excluded for now: its menu bar is native (System Events). */
const SUPPORTED_PLATFORMS: string[] = ["linux", "win32"];

test.describe("bundle update", () => {
  let ctx: AppContext | undefined;
  let server: TestUpdateServer | undefined;

  test.beforeAll(async () => {
    if (!SUPPORTED_PLATFORMS.includes(process.platform)) {
      return;
    }
    const meta = loadMeta();
    if (meta.format !== "targz" || !supportsUpdateSeams(meta.version)) {
      return;
    }
    const bundleJsonPath = path.resolve(
      "artifacts",
      meta.version,
      "bundle.json",
    );
    if (!fs.existsSync(bundleJsonPath)) {
      return;
    }
    server = await startUpdateServer({ bundleJsonPath });
    ctx = await launchApp({
      env: {
        MIMIRI_UPDATE_URL: server.url,
        MIMIRI_UPDATE_KEY: server.publicKeyBase64,
      },
    });
  });

  test.afterAll(async () => {
    await cleanup(ctx);
    await server?.stop();
  });

  test("app updates to a served bundle through the UI", async () => {
    test.skip(
      !SUPPORTED_PLATFORMS.includes(process.platform),
      "bundle-update test runs on Linux and Windows for now (macOS needs native-menu navigation)",
    );
    const meta = loadMeta();
    test.skip(
      meta.format !== "targz",
      "bundle-update test currently targets the targz format only",
    );
    test.skip(
      !supportsUpdateSeams(meta.version),
      "app predates the update seams (< 2.6.9)",
    );
    test.skip(
      !fs.existsSync(path.resolve("artifacts", meta.version, "bundle.json")),
      "no bundle.json for this artifact — re-run npm run fetch",
    );
    const page = ctx!.page;
    const info = await getTestInfo(page);
    test.skip(
      !info?.updateUrl,
      "embedded bundle predates the update seams (shell newer than bundle)",
    );

    await test.step("reach the update settings page", async () => {
      await enterLocalMode(page);
      // Help → "Check for updates" opens the settings-update page (and runs
      // a check against the still-disarmed mock, which offers nothing).
      await page.getByTestId("title-menu-help").click();
      const item = page.getByTestId("menu-check-for-update");
      await expect(item).toBeVisible();
      await item.click();
      await expect(page.getByTestId("update-mode-select")).toBeVisible();
      await expect(page.getByTestId("update-available")).not.toBeVisible();
    });

    await test.step("check discovers the update", async () => {
      // Notify mode BEFORE arming the mock: the default auto-on-idle mode
      // would let a background check silently auto-download and steal the
      // UI flow the test is asserting.
      await page
        .getByTestId("update-mode-select")
        .selectOption("manual-strong");
      server!.setLatest(server!.bundleVersion);
      await page.getByTestId("update-check-button").click();
      await expect(page.getByTestId("update-available")).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByTestId("update-new-version")).toHaveText(
        server!.bundleVersion,
      );
      // StrongNotify also raises an unread update notification.
      await expect(
        page.getByTestId("notification-unread-indicator"),
      ).toBeVisible();
    });

    await test.step("download, verify and install", async () => {
      await page.getByTestId("update-download-button").click();
      // Passes through download → verify → install; "ready" means the
      // bundle was signature-checked and saved. On a signature failure the
      // UI silently resets, so this expectation timing out + the mock's
      // request log are the diagnostics.
      await expect(page.getByTestId("update-restart-button")).toBeVisible({
        timeout: 30_000,
      });
    });

    await test.step("activate and come back on the new bundle", async () => {
      // Activation reloads the window; the CDP target survives the reload,
      // but the click's response may not arrive.
      await page
        .getByTestId("update-restart-button")
        .click({ noWaitAfter: true });
      await enterLocalMode(page);
      await page.getByTestId("title-menu-help").click();
      await page.getByTestId("menu-check-for-update").click();
      await expect(page.getByTestId("update-current-version")).toHaveText(
        server!.bundleVersion,
        { timeout: 15_000 },
      );
    });

    await test.step("host-side bundle state is consistent", async () => {
      const bundlesDir = path.join(ctx!.userDataDir, "bundles");
      const config = JSON.parse(
        fs.readFileSync(path.join(bundlesDir, "config.json"), "utf8"),
      ) as { activeVersion: string };
      expect(config.activeVersion).toBe(server!.bundleVersion);
      expect(fs.existsSync(path.join(bundlesDir, server!.bundleVersion))).toBe(
        true,
      );
      expect(ctx!.process.exitCode).toBeNull();
    });
  });
});
