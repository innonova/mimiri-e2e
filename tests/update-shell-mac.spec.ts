import { test, expect } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";
import {
  launchApp,
  cleanup,
  loadMeta,
  getTestInfo,
  supportsUpdateSeams,
  AppContext,
} from "../helpers/app";
import { enterLocalMode, openCheckForUpdates } from "../helpers/ui";
import { startUpdateServer, TestUpdateServer } from "../helpers/update-server";
import {
  MAC_APP_BUNDLE,
  MAC_SHELL_BASE_VERSION,
  cleanShipItCache,
  extractMacApp,
  macAppBundleId,
  macAppVersion,
  macShellArtifacts,
  killProcessesUnder,
  processRunningUnder,
} from "../helpers/mac-squirrel";

/**
 * Exercises the macOS shell (electron) update end to end, between two REAL
 * signed releases — Squirrel.Mac validates the code signature of the
 * replacement app, so a version-bumped repack (the Windows approach) is not
 * an option. Instead:
 *
 * - The pinned base release (2.6.9, the first with the update seams) is
 *   extracted to a temp dir and launched from there — Squirrel.Mac swaps
 *   the .app in place, wherever it lives, so the fetched artifact stays
 *   pristine.
 * - The mock update server offers a host update and serves the FETCHED
 *   artifact's darwin zip (a genuinely newer signed build) as the payload,
 *   with the ElectronInfo wrapper signed by the per-run test key.
 * - The spec drives the real UI: check → download (raw-signature verify) →
 *   restart, which hands off to Squirrel.Mac — the app quits, ShipIt swaps
 *   the .app and relaunches it. Asserted from the outside via the bundle's
 *   Info.plist version and the relaunched process.
 *
 * Skips when the fetched artifact IS the base version (nothing newer to
 * update to).
 */

test.describe("macos shell update", () => {
  let ctx: AppContext | undefined;
  let server: TestUpdateServer | undefined;
  let workDir: string | undefined;
  let bundleId: string | undefined;

  test.beforeAll(async () => {
    test.setTimeout(600_000);
    if (process.platform !== "darwin") {
      return;
    }
    const meta = loadMeta();
    if (
      !supportsUpdateSeams(meta.version) ||
      meta.version === MAC_SHELL_BASE_VERSION
    ) {
      return;
    }
    const artifacts = macShellArtifacts(meta.version);
    const bundleJsonPath = path.resolve(
      "artifacts",
      meta.version,
      "bundle.json",
    );
    if (
      !fs.existsSync(artifacts.baseZip) ||
      !fs.existsSync(artifacts.updateZip) ||
      !fs.existsSync(bundleJsonPath)
    ) {
      return;
    }
    server = await startUpdateServer({
      bundleJsonPath,
      shellPackagePath: artifacts.updateZip,
    });
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mimiri-shell-update-"));
    const executablePath = extractMacApp(artifacts.baseZip, workDir);
    bundleId = macAppBundleId(path.join(workDir, MAC_APP_BUNDLE));
    ctx = await launchApp({
      executablePath,
      env: {
        MIMIRI_UPDATE_URL: server.url,
        MIMIRI_UPDATE_KEY: server.publicKeyBase64,
      },
    });
  });

  test.afterAll(async () => {
    await cleanup(ctx);
    if (workDir) {
      killProcessesUnder(workDir);
      fs.rmSync(workDir, { recursive: true, force: true });
    }
    cleanShipItCache(bundleId);
    await server?.stop();
  });

  test("app updates its shell through Squirrel.Mac", async () => {
    test.setTimeout(600_000);
    test.skip(process.platform !== "darwin", "shell-update test is macOS-only");
    const meta = loadMeta();
    test.skip(
      !supportsUpdateSeams(meta.version),
      "app predates the update seams (< 2.6.9)",
    );
    test.skip(
      meta.version === MAC_SHELL_BASE_VERSION,
      "fetched artifact is the base version — nothing newer to update to",
    );
    const artifacts = macShellArtifacts(meta.version);
    test.skip(
      !fs.existsSync(artifacts.baseZip) ||
        !fs.existsSync(artifacts.updateZip) ||
        !fs.existsSync(path.resolve("artifacts", meta.version, "bundle.json")),
      "missing base/update zip or bundle.json — re-run npm run fetch",
    );
    const page = ctx!.page;
    const info = await getTestInfo(page);
    test.skip(
      !info?.updateUrl,
      "embedded bundle predates the update seams (shell newer than bundle)",
    );
    const appBundle = path.join(workDir!, MAC_APP_BUNDLE);
    expect(macAppVersion(appBundle)).toBe(MAC_SHELL_BASE_VERSION);

    await test.step("reach the update settings page", async () => {
      await enterLocalMode(page);
      await openCheckForUpdates(ctx!);
      await expect(page.getByTestId("update-mode-select")).toBeVisible();
      await expect(page.getByTestId("update-available")).not.toBeVisible();
    });

    await test.step("check discovers the shell update", async () => {
      await page
        .getByTestId("update-mode-select")
        .selectOption("manual-strong");
      server!.setLatest(server!.bundleVersion, { hostUpdate: true });
      await page.getByTestId("update-check-button").click();
      await expect(page.getByTestId("update-available")).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByTestId("update-new-version")).toHaveText(
        server!.bundleVersion,
      );
    });

    await test.step("download and verify the installer", async () => {
      await page.getByTestId("update-download-button").click();
      // ~230 MB from localhost, raw-signature verify, then staged to the
      // temp dir as releases.json + zip.
      await expect(page.getByTestId("update-restart-button")).toBeVisible({
        timeout: 300_000,
      });
    });

    await test.step("restart hands off to Squirrel.Mac", async () => {
      // quitAndInstall: the app exits, ShipIt swaps the .app bundle and
      // relaunches it — the CDP connection dies with it, so from here
      // everything is asserted from the outside.
      await page
        .getByTestId("update-restart-button")
        .click({ noWaitAfter: true });
      await expect
        .poll(() => macAppVersion(appBundle), {
          message: `ShipIt to swap ${appBundle} to ${meta.version}`,
          timeout: 300_000,
        })
        .toBe(meta.version);
      // Match the app binary path specifically — a plain workDir match
      // would also hit the ShipIt installer process, whose command line
      // contains the target .app path.
      await expect
        .poll(
          () => processRunningUnder(path.join(appBundle, "Contents", "MacOS")),
          {
            message: "the app to be relaunched from the updated bundle",
            timeout: 120_000,
          },
        )
        .toBe(true);
    });
  });
});
