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
  SHELL_UPGRADE_BASE_VERSION,
} from "../helpers/app";
import { enterLocalMode } from "../helpers/ui";
import { startUpdateServer, TestUpdateServer } from "../helpers/update-server";
import {
  APP_EXE_NAME,
  installSquirrelApp,
  killAppInstances,
  uninstallSquirrelApp,
  repackNupkg,
  runningAppPaths,
  squirrelRoot,
  waitForCondition,
  winShellArtifacts,
} from "../helpers/win-squirrel";

/**
 * Exercises the Windows shell (electron) update end to end, for real:
 *
 * - A published Setup.exe performs a genuine Squirrel install into
 *   %LOCALAPPDATA%\mimiri_notes (the in-app updater only works from that
 *   layout — Update.exe next to app-<version>).
 * - The local mock update server serves a full nupkg, signed with the
 *   per-run test key; the app is driven through the real UI: check →
 *   download (signature verify over the raw installer bytes) → restart,
 *   which hands off to Squirrel — the app quits, Update.exe applies the
 *   package and relaunches the app from the new app-<version> dir.
 * - The updated install is then relaunched attached (debug port + seams)
 *   and must report the new version and reach a working UI.
 *
 * Preferred payload: the pinned base release (SHELL_UPGRADE_BASE_VERSION)
 * is installed and updated to the fetched artifact's own REAL nupkg — that
 * proves the updated binary actually works, not just that the swap happened.
 * Squirrel only trusts the SHA1 from the RELEASES line (no Authenticode or
 * version coupling), so the real package serves as-is. When the fetched
 * artifact IS the base (nothing real to update to), it falls back to the
 * published nupkg repacked under version 99.0.0: binaries unchanged, but
 * the mechanism still runs end to end.
 *
 * The suite owns machine-global state (the Squirrel installation) and
 * uninstalls it afterwards.
 */

const REPACK_UPDATE_VERSION = "99.0.0";

test.describe("windows shell update", () => {
  let ctx: AppContext | undefined;
  let server: TestUpdateServer | undefined;
  /** Version the update is expected to land on (real or repacked). */
  let toVersion: string | undefined;

  test.beforeAll(async () => {
    test.setTimeout(600_000);
    if (process.platform !== "win32") {
      return;
    }
    const meta = loadMeta();
    if (!supportsUpdateSeams(meta.version)) {
      return;
    }
    const artifacts = winShellArtifacts(meta.version);
    const bundleJsonPath = path.resolve(
      "artifacts",
      meta.version,
      "bundle.json",
    );
    if (
      !fs.existsSync(artifacts.nupkg) ||
      !fs.existsSync(artifacts.setupExe) ||
      !fs.existsSync(bundleJsonPath)
    ) {
      return;
    }

    const base = winShellArtifacts(SHELL_UPGRADE_BASE_VERSION);
    const real =
      meta.version !== SHELL_UPGRADE_BASE_VERSION &&
      fs.existsSync(base.setupExe);
    const fromVersion = real ? SHELL_UPGRADE_BASE_VERSION : meta.version;
    toVersion = real ? meta.version : REPACK_UPDATE_VERSION;
    const shellPackagePath = real
      ? artifacts.nupkg
      : repackNupkg(artifacts.nupkg, REPACK_UPDATE_VERSION);

    server = await startUpdateServer({ bundleJsonPath, shellPackagePath });
    const installedExe = await installSquirrelApp(
      real ? base.setupExe : artifacts.setupExe,
      fromVersion,
    );
    ctx = await launchApp({
      executablePath: installedExe,
      env: {
        MIMIRI_UPDATE_URL: server.url,
        MIMIRI_UPDATE_KEY: server.publicKeyBase64,
      },
    });
  });

  test.afterAll(async () => {
    await cleanup(ctx);
    if (process.platform === "win32") {
      uninstallSquirrelApp();
    }
    await server?.stop();
  });

  test("app updates its shell through Squirrel", async () => {
    test.setTimeout(600_000);
    test.skip(
      process.platform !== "win32",
      "shell-update test is Windows-only",
    );
    const meta = loadMeta();
    test.skip(
      !supportsUpdateSeams(meta.version),
      "app predates the update seams (< 2.6.9)",
    );
    const artifacts = winShellArtifacts(meta.version);
    test.skip(
      !fs.existsSync(artifacts.nupkg) ||
        !fs.existsSync(artifacts.setupExe) ||
        !fs.existsSync(path.resolve("artifacts", meta.version, "bundle.json")),
      "missing nupkg/Setup.exe/bundle.json — re-run npm run fetch",
    );
    const page = ctx!.page;
    const info = await getTestInfo(page);
    test.skip(
      !info?.updateUrl,
      "embedded bundle predates the update seams (shell newer than bundle)",
    );

    await test.step("reach the update settings page", async () => {
      await enterLocalMode(page);
      await page.getByTestId("title-menu-help").click();
      const item = page.getByTestId("menu-check-for-update");
      await expect(item).toBeVisible();
      await item.click();
      await expect(page.getByTestId("update-mode-select")).toBeVisible();
      await expect(page.getByTestId("update-available")).not.toBeVisible();
    });

    await test.step("check discovers the shell update", async () => {
      await page
        .getByTestId("update-mode-select")
        .selectOption("manual-strong");
      server!.setLatest(toVersion!, { hostUpdate: true });
      await page.getByTestId("update-check-button").click();
      await expect(page.getByTestId("update-available")).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByTestId("update-new-version")).toHaveText(
        toVersion!,
      );
    });

    await test.step("download and verify the installer", async () => {
      await page.getByTestId("update-download-button").click();
      // ~150 MB from localhost, raw-signature verify, then staged to
      // %TEMP%\MimiriUpdate as RELEASES + nupkg.
      await expect(page.getByTestId("update-restart-button")).toBeVisible({
        timeout: 180_000,
      });
    });

    await test.step("restart hands off to Squirrel", async () => {
      // quitAndInstall: the app exits, Update.exe applies the package and
      // relaunches the app — the CDP connection dies with it, so from here
      // everything is asserted from the outside.
      await page
        .getByTestId("update-restart-button")
        .click({ noWaitAfter: true });
      // Disarm before anything relaunches: a pointer still offering the
      // now-installed version reads as a pending BUNDLE of that version —
      // a state no real host produces — and wedges the boot in the update
      // screen.
      server!.setLatest(null);
      const newAppDir = path.join(squirrelRoot(), `app-${toVersion}`);
      await waitForCondition(
        `Squirrel to install ${newAppDir}`,
        () => fs.existsSync(newAppDir),
        180_000,
      );
      await waitForCondition(
        "the app to be relaunched from the new version",
        () => runningAppPaths().some((p) => p.includes(`app-${toVersion}`)),
        120_000,
      );
    });

    await test.step("the updated install boots attached and works", async () => {
      // The Squirrel-relaunched instance runs without the debug port —
      // replace it with an attached launch from the new install and prove
      // the updated binary is actually functional (with the real payload
      // this is the fetched version's binary, not the one that updated).
      await cleanup(ctx);
      ctx = undefined;
      killAppInstances();
      await waitForCondition(
        "the app to exit",
        () => runningAppPaths().length === 0,
        30_000,
      );
      const newExe = path.join(
        squirrelRoot(),
        `app-${toVersion}`,
        APP_EXE_NAME,
      );
      ctx = await launchApp({ executablePath: newExe });
      const updated = await getTestInfo(ctx.page);
      // The repack fallback swaps install dirs but not binaries, so the
      // self-reported version is the fetched artifact's in both modes.
      expect(updated?.version).toBe(meta.version);
      await enterLocalMode(ctx.page);
    });
  });
});
