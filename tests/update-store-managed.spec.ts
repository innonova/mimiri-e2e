import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";
import {
  launchApp,
  cleanup,
  loadMeta,
  getTestInfo,
  supportsStoreDetection,
  versionAtLeast,
  AppContext,
} from "../helpers/app";
import { enterLocalMode, openCheckForUpdates } from "../helpers/ui";
import { startUpdateServer, TestUpdateServer } from "../helpers/update-server";

/**
 * When a bundle requires a newer shell, Linux installs present the host
 * update differently by install source:
 *
 * - direct installs (targz/appimage, sideloaded flatpak/snap): a manual
 *   download link — the user updates by hand,
 * - store installs (flathub / snap store): a "requires a newer app" notice
 *   with NO download link — the store delivers the shell.
 *
 * The shell detects the install source (2.6.13+: flatpak branch for
 * flathub, numeric snap revision for the store) and exposes a test-mode
 * override (MIMIRI_FAKE_STORE) since e2e installs are always sideloads.
 * One case per launch, all on the fetched artifact.
 */

const CASES: { name: string; fakeStore?: string; storeManaged: boolean }[] = [
  { name: "flathub", fakeStore: "flathub", storeManaged: true },
  { name: "snap store", fakeStore: "snapstore", storeManaged: true },
  { name: "direct install", storeManaged: false },
];

for (const c of CASES) {
  test.describe(`host update presentation (${c.name})`, () => {
    let ctx: AppContext | undefined;
    let server: TestUpdateServer | undefined;

    test.afterAll(async () => {
      await cleanup(ctx);
      await server?.stop();
    });

    test(`shows ${c.storeManaged ? "the store notice" : "a manual download link"}`, async () => {
      test.skip(process.platform !== "linux", "Linux-only presentation");
      const meta = loadMeta();
      test.skip(
        !supportsStoreDetection(meta.version),
        "shell predates store detection (< 2.6.13)",
      );
      test.skip(
        !fs.existsSync(path.resolve("artifacts", meta.version, "bundle.json")),
        "no bundle.json — re-run npm run fetch",
      );

      server = await startUpdateServer({
        bundleJsonPath: path.resolve("artifacts", meta.version, "bundle.json"),
      });
      ctx = await launchApp({
        env: {
          MIMIRI_UPDATE_URL: server.url,
          MIMIRI_UPDATE_KEY: server.publicKeyBase64,
          ...(c.fakeStore ? { MIMIRI_FAKE_STORE: c.fakeStore } : {}),
        },
      });
      const page = ctx.page;
      await enterLocalMode(page);
      const info = await getTestInfo(page);
      test.skip(!info?.updateUrl, "bundle predates the update seams");
      test.skip(
        !versionAtLeast(info!.baseVersion, 2, 6, 7),
        "bundle predates the store-managed update state (< 2.6.7)",
      );

      await openCheckForUpdates(ctx);
      await expect(page.getByTestId("update-mode-select")).toBeVisible();
      await page
        .getByTestId("update-mode-select")
        .selectOption("manual-strong");
      server.setLatest(server.bundleVersion, { hostUpdate: true });
      await page.getByTestId("update-check-button").click();
      await expect(page.getByTestId("update-available")).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByTestId("update-new-version")).toHaveText(
        server.bundleVersion,
      );
      // A host update on Linux never offers the in-app updater.
      await expect(
        page.getByTestId("update-download-button"),
      ).not.toBeVisible();

      if (c.storeManaged) {
        await expect(page.getByTestId("update-store-managed")).toBeVisible();
        await expect(
          page.getByTestId("update-manual-download"),
        ).not.toBeVisible();
      } else {
        // On the flatpak/snap legs this also validates the REAL negative
        // detection: sideloaded installs must NOT present as store-managed.
        const manual = page.getByTestId("update-manual-download");
        await expect(manual).toBeVisible();
        const suffix = {
          targz: "tar.gz",
          appimage: "AppImage",
          flatpak: "flatpak",
          snap: "snap",
        }[meta.format ?? "targz"];
        await expect(manual).toContainText(
          `mimiri-notes_${server.bundleVersion}_amd64.${suffix}`,
        );
        await expect(
          page.getByTestId("update-store-managed"),
        ).not.toBeVisible();
      }
    });
  });
}
