import { test, expect } from "@playwright/test";
import { spawnSync } from "child_process";
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
import { FLATPAK_APP_ID } from "../helpers/format";

/**
 * The package-manager flavour of a shell upgrade — the closest testable
 * stand-in for the flathub/snap-store update flows. The store transport
 * itself (ostree pull, snapd refresh scheduling) is flatpak/snapd code and
 * is deliberately NOT under test; what IS ours — and what this covers — is
 * everything the app does when the package manager swaps the shell
 * underneath existing state: user data survival and active-bundle
 * reconciliation. Local `flatpak install`/`snap install --dangerous` of a
 * newer package over an older one exercises the same upgrade semantics the
 * stores trigger (snapd revision bump, flatpak commit replacement).
 *
 * Installing old versions is delegated to fetch-artifact (it already owns
 * install + verification); current.json is snapshotted around it since an
 * explicit fetch repoints it.
 */

function fetchVersion(version: string, format: string): void {
  const currentFile = path.resolve("artifacts", "current.json");
  const saved = fs.readFileSync(currentFile, "utf8");
  const result = spawnSync(
    "npx",
    ["tsx", "scripts/fetch-artifact.ts", version, `--format=${format}`],
    { encoding: "utf8", timeout: 600_000 },
  );
  fs.writeFileSync(currentFile, saved);
  if (result.status !== 0) {
    throw new Error(
      `fetch ${version} (${format}) failed: ${result.stdout}\n${result.stderr}`,
    );
  }
}

function installPackageOver(version: string, format: string): void {
  const downloads = path.resolve("artifacts", "downloads");
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  if (format === "flatpak") {
    const bundle = path.join(
      downloads,
      `${FLATPAK_APP_ID}_${version}_${arch}.flatpak`,
    );
    const r = spawnSync("flatpak", ["install", "--user", "-y", bundle], {
      encoding: "utf8",
    });
    if (r.status !== 0) {
      throw new Error(`flatpak install failed: ${r.stderr}`);
    }
  } else {
    const bundle = path.join(downloads, `mimiri-notes_${version}_${arch}.snap`);
    const r = spawnSync("sudo", ["snap", "install", "--dangerous", bundle], {
      encoding: "utf8",
    });
    if (r.status !== 0) {
      throw new Error(`snap install failed: ${r.stderr}`);
    }
  }
}

test.describe("package-manager shell upgrade", () => {
  let ctx: AppContext | undefined;
  let server: TestUpdateServer | undefined;
  let userDataDir: string | undefined;

  test.afterAll(async () => {
    await cleanup(ctx);
    if (userDataDir) {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
    await server?.stop();
  });

  test("upgrade via package manager keeps data and bundle state", async () => {
    test.setTimeout(900_000);
    const meta = loadMeta();
    test.skip(
      process.platform !== "linux" ||
        !["flatpak", "snap"].includes(meta.format ?? ""),
      "flatpak/snap only — other formats are covered by the external-install flow",
    );
    test.skip(
      !supportsUpdateSeams(meta.version) ||
        meta.version === SHELL_UPGRADE_BASE_VERSION,
      "needs a fetched artifact newer than the pinned base",
    );
    test.skip(
      !fs.existsSync(path.resolve("artifacts", meta.version, "bundle.json")),
      "no bundle.json — re-run npm run fetch",
    );
    const format = meta.format!;

    server = await startUpdateServer({
      bundleJsonPath: path.resolve("artifacts", meta.version, "bundle.json"),
    });
    userDataDir = fs.mkdtempSync(
      format === "snap"
        ? path.join(os.homedir(), "mimiri-e2e-pkgup-")
        : path.join(os.tmpdir(), "mimiri-e2e-pkgup-"),
    );

    await test.step("install and run the base version", async () => {
      // Downloads AND installs the base package (fetch owns install logic).
      fetchVersion(SHELL_UPGRADE_BASE_VERSION, format);
      ctx = await launchApp({
        version: SHELL_UPGRADE_BASE_VERSION,
        format,
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

    await test.step("upgrade the package to the fetched version", async () => {
      await cleanup(ctx, { keepUserData: true });
      ctx = undefined;
      installPackageOver(meta.version, format);
      ctx = await launchApp({
        version: meta.version,
        format,
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
      await openCheckForUpdates(ctx!);
      await expect(page.getByTestId("update-current-version")).toHaveText(
        server!.bundleVersion,
        { timeout: 15_000 },
      );
    });
  });
});
