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
import {
  installSquirrelApp,
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
 * - The published Setup.exe performs a genuine Squirrel install into
 *   %LOCALAPPDATA%\mimiri_notes (the in-app updater only works from that
 *   layout — Update.exe next to app-<version>).
 * - The published full nupkg is repacked with its .nuspec version bumped
 *   to 99.0.0 (binaries unchanged) and served by the local mock update
 *   server, signed with the per-run test key.
 * - The app is launched from the installed copy with the
 *   MIMIRI_UPDATE_URL/MIMIRI_UPDATE_KEY seams and driven through the real
 *   UI: check → download (signature verify over the raw installer bytes)
 *   → restart, which hands off to Squirrel — the app quits, Update.exe
 *   applies the package and relaunches the app from app-99.0.0.
 *
 * The suite owns machine-global state (the Squirrel installation) and
 * uninstalls it afterwards.
 */

const SHELL_UPDATE_VERSION = "99.0.0";

test.describe("windows shell update", () => {
  let ctx: AppContext | undefined;
  let server: TestUpdateServer | undefined;
  let installedExe: string | undefined;

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
    const shellNupkgPath = repackNupkg(artifacts.nupkg, SHELL_UPDATE_VERSION);
    server = await startUpdateServer({ bundleJsonPath, shellNupkgPath });
    installedExe = await installSquirrelApp(artifacts.setupExe, meta.version);
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
      server!.setLatest(SHELL_UPDATE_VERSION, { hostUpdate: true });
      await page.getByTestId("update-check-button").click();
      await expect(page.getByTestId("update-available")).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByTestId("update-new-version")).toHaveText(
        SHELL_UPDATE_VERSION,
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
      const newAppDir = path.join(
        squirrelRoot(),
        `app-${SHELL_UPDATE_VERSION}`,
      );
      await waitForCondition(
        `Squirrel to install ${newAppDir}`,
        () => fs.existsSync(newAppDir),
        180_000,
      );
      await waitForCondition(
        "the app to be relaunched from the new version",
        () =>
          runningAppPaths().some((p) =>
            p.includes(`app-${SHELL_UPDATE_VERSION}`),
          ),
        120_000,
      );
    });
  });
});
