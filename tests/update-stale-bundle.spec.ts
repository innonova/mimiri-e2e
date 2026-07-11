import { test, expect } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";
import {
  launchApp,
  cleanup,
  loadMeta,
  getTestInfo,
  AppContext,
} from "../helpers/app";
import { enterLocalMode, openCheckForUpdates } from "../helpers/ui";

/**
 * A shell upgrade (store refresh, manual install, Squirrel) can leave an
 * installed bundle that is OLDER than the new shell's embedded base bundle.
 * The BundleManager constructor must discard it in favour of base — the
 * branch real users exercise whenever a shell update leapfrogs their last
 * bundle update. Seeds exactly that state and asserts the app boots on the
 * base bundle.
 */

test.describe("stale active bundle", () => {
  let ctx: AppContext | undefined;

  test.afterAll(async () => {
    await cleanup(ctx);
  });

  test("active bundle older than base is discarded at startup", async () => {
    const meta = loadMeta();
    const userDataDir = fs.mkdtempSync(
      meta.format === "snap"
        ? path.join(os.homedir(), "mimiri-e2e-stale-")
        : path.join(os.tmpdir(), "mimiri-e2e-stale-"),
    );
    // A "healthy" (index.html present, no unmet references) but ancient
    // bundle, marked active.
    const stale = path.join(userDataDir, "bundles", "0.1.0");
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(
      path.join(stale, "index.html"),
      "<html><body>ancient</body></html>",
    );
    fs.writeFileSync(
      path.join(stale, "info.json"),
      JSON.stringify({
        version: "0.1.0",
        description: "",
        releaseDate: new Date().toISOString(),
      }),
    );
    fs.writeFileSync(
      path.join(userDataDir, "bundles", "config.json"),
      JSON.stringify({ activeVersion: "0.1.0", previousActiveVersion: "base" }),
    );

    // No update seams passed: the update system stays inert (check() is
    // gated in test mode without the URL override) — this test is purely
    // about startup reconciliation.
    ctx = await launchApp({ userDataDir });
    // enterLocalMode succeeding already proves the app markup rendered —
    // the seeded "ancient" bundle contains none of it.
    await enterLocalMode(ctx.page);
    const info = await getTestInfo(ctx.page);
    test.skip(info === undefined, "app predates the test seam (< 2.6.5)");
    expect(info!.version).toBe(meta.version);
    // The RUNNING bundle version must be the embedded base, not 0.1.0.
    await openCheckForUpdates(ctx);
    await expect(ctx.page.getByTestId("update-current-version")).toHaveText(
      info!.baseVersion,
      { timeout: 15_000 },
    );
  });
});
