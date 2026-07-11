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
 *
 * The store-managed UI needs a bundle >= 2.6.7, which the shell's embedded
 * base may lag behind — so each case first bundle-updates to the mock's
 * transformed bundle (built from the published >= 2.6.7 bundle.json) and
 * only then arms a host update on top. This keeps the spec independent of
 * which base bundle a shell release happened to embed.
 */

/** Offered on top of the already-applied 99.0.0 bundle. */
const HOST_UPDATE_VERSION = "99.0.1";

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
      test.setTimeout(300_000);
      test.skip(process.platform !== "linux", "Linux-only presentation");
      const meta = loadMeta();
      test.skip(
        !supportsStoreDetection(meta.version),
        "shell predates store detection (< 2.6.13)",
      );
      const bundleJsonPath = path.resolve(
        "artifacts",
        meta.version,
        "bundle.json",
      );
      test.skip(
        !fs.existsSync(bundleJsonPath),
        "no bundle.json — re-run npm run fetch",
      );
      const published = JSON.parse(fs.readFileSync(bundleJsonPath, "utf8")) as {
        version: string;
      };
      test.skip(
        !versionAtLeast(published.version, 2, 6, 7),
        "published bundle predates the store-managed update UI (< 2.6.7)",
      );

      server = await startUpdateServer({ bundleJsonPath });
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

      // First bring the RUNNING bundle to >= 2.6.7 via a normal bundle
      // update (the embedded base may predate the store-managed UI).
      // Checks are triggered through the Help menu, not the settings-page
      // button: the button hides as soon as an update is known, and a
      // BACKGROUND check (fired on session events) can discover the armed
      // update between arming and clicking, leaving the click hanging on a
      // vanished button.
      await openCheckForUpdates(ctx);
      await expect(page.getByTestId("update-mode-select")).toBeVisible();
      await page
        .getByTestId("update-mode-select")
        .selectOption("manual-strong");
      server.setLatest(server.bundleVersion);
      await openCheckForUpdates(ctx);
      await expect(page.getByTestId("update-available")).toBeVisible({
        timeout: 15_000,
      });
      await page.getByTestId("update-download-button").click();
      await expect(page.getByTestId("update-restart-button")).toBeVisible({
        timeout: 60_000,
      });
      await page
        .getByTestId("update-restart-button")
        .click({ noWaitAfter: true });
      await enterLocalMode(page);
      await openCheckForUpdates(ctx);
      await expect(page.getByTestId("update-current-version")).toHaveText(
        server.bundleVersion,
        { timeout: 15_000 },
      );

      // Now offer a HOST update on top and assert its presentation.
      server.setLatest(HOST_UPDATE_VERSION, { hostUpdate: true });
      await openCheckForUpdates(ctx);
      await expect(page.getByTestId("update-available")).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByTestId("update-new-version")).toHaveText(
        HOST_UPDATE_VERSION,
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
          `mimiri-notes_${HOST_UPDATE_VERSION}_amd64.${suffix}`,
        );
        await expect(
          page.getByTestId("update-store-managed"),
        ).not.toBeVisible();
      }
    });
  });
}
