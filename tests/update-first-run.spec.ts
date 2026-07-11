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
import { enterLocalMode, openCheckForUpdates } from "../helpers/ui";
import { startUpdateServer, TestUpdateServer } from "../helpers/update-server";

/**
 * A fresh install (or the first boot after any shell change) must pull the
 * latest bundle immediately at startup, before the app reaches ready and
 * regardless of the update-mode setting — checkUpdateInitial() fires when
 * lastRunHostVersion differs from the running shell. This keeps clean
 * installs from running a stale embedded base when a newer bundle is
 * already published (e.g. a release that shipped without re-running
 * update-bundle).
 *
 * Unlike the other update specs, the mock is ARMED BEFORE the first launch;
 * the app must self-update with zero UI interaction.
 */

test.describe("first-run bundle update", () => {
  let ctx: AppContext | undefined;
  let server: TestUpdateServer | undefined;

  test.afterAll(async () => {
    await cleanup(ctx);
    await server?.stop();
  });

  test("fresh install boots straight onto the latest bundle", async () => {
    test.setTimeout(300_000);
    const meta = loadMeta();
    test.skip(
      !supportsUpdateSeams(meta.version),
      "app predates the update seams (< 2.6.9)",
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

    server = await startUpdateServer({ bundleJsonPath });
    // Armed before the app ever runs: this is what a clean machine sees.
    server.setLatest(server.bundleVersion);

    ctx = await launchApp({
      env: {
        MIMIRI_UPDATE_URL: server.url,
        MIMIRI_UPDATE_KEY: server.publicKeyBase64,
      },
    });
    const page = ctx.page;
    // Reaching ready implies the startup update (check → download →
    // activate → reload) already completed underneath.
    await enterLocalMode(page);
    const info = await getTestInfo(page);
    test.skip(!info?.updateUrl, "bundle predates the update seams");

    // The RUNNING bundle is the served one — no UI interaction happened.
    await openCheckForUpdates(ctx);
    await expect(page.getByTestId("update-current-version")).toHaveText(
      server.bundleVersion,
      { timeout: 15_000 },
    );

    // Host-side: the bundle was installed and activated.
    const config = JSON.parse(
      fs.readFileSync(
        path.join(ctx.userDataDir, "bundles", "config.json"),
        "utf8",
      ),
    ) as { activeVersion: string };
    expect(config.activeVersion).toBe(server.bundleVersion);
  });
});
