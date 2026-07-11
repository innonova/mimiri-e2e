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
  SHELL_UPGRADE_BASE_VERSION,
  AppContext,
} from "../helpers/app";
import {
  enterLocalMode,
  openCheckForUpdates,
  createRootNote,
} from "../helpers/ui";
import { startUpdateServer, TestUpdateServer } from "../helpers/update-server";
import {
  installShell,
  upgradeShell,
  shellArchivePath,
} from "../helpers/shell-upgrade";
import { uninstallSquirrelApp } from "../helpers/win-squirrel";

/**
 * Exercises the "user downloads a newer build from the website and installs
 * it over the existing one" path — the shell being replaced by something
 * OTHER than the in-app updater (which is also how store-managed installs
 * behave from the app's perspective):
 *
 * - install the pinned base release (2.6.9), create a note, bundle-update
 *   to the mock's 99.0.0 (so a newer-than-base bundle is active),
 * - quit, install the FETCHED artifact's version over it (extract-over on
 *   Linux/macOS, the real newer Setup.exe on Windows),
 * - relaunch against the same profile and assert: the new shell runs, the
 *   note survived, and the active bundle — still newer than the new base —
 *   stays active (the BundleManager reconciliation that store/manual
 *   upgrades exercise for real users).
 */

test.describe("external shell upgrade", () => {
  let ctx: AppContext | undefined;
  let server: TestUpdateServer | undefined;
  let workDir: string | undefined;
  let userDataDir: string | undefined;

  const supported = () =>
    ["linux", "darwin", "win32"].includes(process.platform);

  test.afterAll(async () => {
    await cleanup(ctx);
    if (process.platform === "win32") {
      uninstallSquirrelApp();
    }
    if (workDir) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
    if (userDataDir) {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
    await server?.stop();
  });

  test("newer install over an existing one keeps data and bundle state", async () => {
    test.setTimeout(600_000);
    test.skip(!supported(), "runs on Linux, Windows and macOS");
    const meta = loadMeta();
    test.skip(
      meta.format !== "targz",
      "package-manager formats are covered by their own upgrade flows",
    );
    test.skip(
      !supportsUpdateSeams(meta.version) ||
        meta.version === SHELL_UPGRADE_BASE_VERSION,
      "needs a fetched artifact newer than the pinned base",
    );
    test.skip(
      !fs.existsSync(shellArchivePath(SHELL_UPGRADE_BASE_VERSION)) ||
        !fs.existsSync(shellArchivePath(meta.version)) ||
        !fs.existsSync(path.resolve("artifacts", meta.version, "bundle.json")),
      "missing base/current archives or bundle.json — re-run npm run fetch",
    );

    server = await startUpdateServer({
      bundleJsonPath: path.resolve("artifacts", meta.version, "bundle.json"),
    });
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mimiri-extup-"));
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mimiri-extup-data-"));

    await test.step("install and run the base version", async () => {
      const exe = await installShell(SHELL_UPGRADE_BASE_VERSION, workDir!);
      ctx = await launchApp({
        executablePath: exe,
        userDataDir,
        env: {
          MIMIRI_UPDATE_URL: server!.url,
          MIMIRI_UPDATE_KEY: server!.publicKeyBase64,
        },
      });
      await enterLocalMode(ctx.page);
      const info = await getTestInfo(ctx.page);
      expect(info?.version).toBe(SHELL_UPGRADE_BASE_VERSION);
      test.skip(!info?.updateUrl, "base bundle predates the update seams");
      await createRootNote(ctx, "survives-upgrade");
    });

    await test.step("bundle-update to a newer-than-base bundle", async () => {
      const page = ctx!.page;
      await openCheckForUpdates(ctx!);
      await expect(page.getByTestId("update-mode-select")).toBeVisible();
      await page
        .getByTestId("update-mode-select")
        .selectOption("manual-strong");
      server!.setLatest(server!.bundleVersion);
      await page.getByTestId("update-check-button").click();
      await expect(page.getByTestId("update-available")).toBeVisible({
        timeout: 15_000,
      });
      await page.getByTestId("update-download-button").click();
      await expect(page.getByTestId("update-restart-button")).toBeVisible({
        timeout: 60_000,
      });
      // The 2.6.9 base shell predates clearCache-on-activate (2.6.10).
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Network.clearBrowserCache");
      await cdp.detach();
      await page
        .getByTestId("update-restart-button")
        .click({ noWaitAfter: true });
      await enterLocalMode(page);
      await openCheckForUpdates(ctx!);
      await expect(page.getByTestId("update-current-version")).toHaveText(
        server!.bundleVersion,
        { timeout: 15_000 },
      );
    });

    await test.step("install the fetched version over it", async () => {
      await cleanup(ctx, { keepUserData: true });
      ctx = undefined;
      const exe = await upgradeShell(meta.version, workDir!);
      ctx = await launchApp({
        executablePath: exe,
        userDataDir,
        env: {
          MIMIRI_UPDATE_URL: server!.url,
          MIMIRI_UPDATE_KEY: server!.publicKeyBase64,
        },
      });
    });

    await test.step("new shell runs with data and bundle intact", async () => {
      const page = ctx!.page;
      await enterLocalMode(page);
      const info = await getTestInfo(page);
      expect(info?.version).toBe(meta.version);
      await expect(
        page.getByTestId("note-tree").getByTitle("survives-upgrade", {
          exact: true,
        }),
      ).toBeVisible();
      // The active bundle (99.0.0) is newer than the new shell's base
      // bundle and must stay active across the shell swap.
      await openCheckForUpdates(ctx!);
      await expect(page.getByTestId("update-current-version")).toHaveText(
        server!.bundleVersion,
        { timeout: 15_000 },
      );
    });
  });
});
