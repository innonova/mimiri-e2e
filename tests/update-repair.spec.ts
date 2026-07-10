import { test, expect } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";
import {
  launchApp,
  cleanup,
  loadMeta,
  getTestInfo,
  supportsBundleRepair,
  AppContext,
} from "../helpers/app";
import { enterLocalMode, openCheckForUpdates } from "../helpers/ui";
import { startUpdateServer, TestUpdateServer } from "../helpers/update-server";

/**
 * Exercises the shell's recovery from a partially written bundle
 * (2.6.11+). Older shells could promote a half-saved bundle dir when an
 * automatic and a manual update raced — the broken dir then presented as
 * installed, every retry skipped the download, and the app kept activating
 * a dead page (seen in the wild as a grey screen with ERR_UNEXPECTED for
 * the bundle's assets).
 *
 * The spec pre-seeds exactly that state — config pointing at a bundle dir
 * that has index.html and info.json but is missing the assets index.html
 * references, plus a stale interrupted-download dir — and asserts the shell
 * boots usable on the base bundle, sweeps the leftovers, reports missing
 * files as 404 (not net::ERR_UNEXPECTED), and repairs the broken version
 * through a normal re-update.
 */

const SUPPORTED_PLATFORMS: string[] = ["linux", "win32", "darwin"];

test.describe("bundle repair", () => {
  let ctx: AppContext | undefined;
  let server: TestUpdateServer | undefined;

  test.beforeAll(async () => {
    if (!SUPPORTED_PLATFORMS.includes(process.platform)) {
      return;
    }
    const meta = loadMeta();
    if (!supportsBundleRepair(meta.version)) {
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

    // The broken state: active bundle dir exists with index.html and
    // info.json, but the assets index.html references are missing.
    // Strict snap confinement has a private /tmp and the home interface
    // excludes dotfiles, so for snap the dir must be a non-hidden path
    // under $HOME (same constraint launchApp handles for its default dir).
    const userDataDir = fs.mkdtempSync(
      meta.format === "snap"
        ? path.join(os.homedir(), "mimiri-e2e-repair-")
        : path.join(os.tmpdir(), "mimiri-e2e-repair-"),
    );
    const broken = path.join(userDataDir, "bundles", server.bundleVersion);
    fs.mkdirSync(path.join(broken, "assets"), { recursive: true });
    fs.writeFileSync(
      path.join(broken, "index.html"),
      '<html><head><script src="/assets/missing-DeadBeef.js"></script></head><body></body></html>',
    );
    fs.writeFileSync(
      path.join(broken, "info.json"),
      JSON.stringify({
        version: server.bundleVersion,
        description: "",
        releaseDate: new Date().toISOString(),
      }),
    );
    fs.mkdirSync(
      path.join(
        userDataDir,
        "bundles",
        `${server.bundleVersion}.downloading-stale`,
      ),
      { recursive: true },
    );
    fs.writeFileSync(
      path.join(userDataDir, "bundles", "config.json"),
      JSON.stringify({
        activeVersion: server.bundleVersion,
        previousActiveVersion: "base",
      }),
    );

    ctx = await launchApp({
      userDataDir,
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

  test("app recovers from a partially written active bundle", async () => {
    test.skip(
      !SUPPORTED_PLATFORMS.includes(process.platform),
      "bundle-repair test runs on Linux, Windows and macOS",
    );
    const meta = loadMeta();
    test.skip(
      !supportsBundleRepair(meta.version),
      "shell predates hardened bundle handling (< 2.6.11)",
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

    await test.step("boots usable on the base bundle", async () => {
      await enterLocalMode(page);
    });

    await test.step("stale interrupted download was swept", async () => {
      expect(
        fs.existsSync(
          path.join(
            ctx!.userDataDir,
            "bundles",
            `${server!.bundleVersion}.downloading-stale`,
          ),
        ),
      ).toBe(false);
    });

    await test.step("missing files are 404, not ERR_UNEXPECTED", async () => {
      const status = await page.evaluate(async () => {
        const r = await fetch("/assets/definitely-not-there.js");
        return r.status;
      });
      expect(status).toBe(404);
    });

    await test.step("re-update repairs the broken bundle", async () => {
      await openCheckForUpdates(ctx!);
      await expect(page.getByTestId("update-mode-select")).toBeVisible();
      await page
        .getByTestId("update-mode-select")
        .selectOption("manual-strong");
      server!.setLatest(server!.bundleVersion);
      await page.getByTestId("update-check-button").click();
      // The broken dir must NOT present as installed — the update is
      // offered and re-downloaded rather than short-circuited.
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
      await openCheckForUpdates(ctx!);
      await expect(page.getByTestId("update-current-version")).toHaveText(
        server!.bundleVersion,
        { timeout: 15_000 },
      );
    });

    await test.step("repaired bundle is complete on disk", async () => {
      const assets = path.join(
        ctx!.userDataDir,
        "bundles",
        server!.bundleVersion,
        "assets",
      );
      expect(fs.readdirSync(assets).length).toBeGreaterThan(100);
      expect(ctx!.process.exitCode).toBeNull();
    });
  });
});
