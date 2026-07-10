import { test, expect } from "@playwright/test";
import { spawnSync } from "child_process";
import { launchApp, cleanup, getTestInfo, AppContext } from "../helpers/app";
import { FLATPAK_APP_ID } from "../helpers/format";

test.describe("smoke test", () => {
  let ctx: AppContext;

  test.beforeAll(async () => {
    ctx = await launchApp();
  });

  test.afterAll(async () => {
    await cleanup(ctx);
  });

  test("main window opens and loads", async () => {
    await ctx.page.waitForLoadState("domcontentloaded");
  });

  test("window title mentions Mimiri", async () => {
    await expect(async () => {
      expect(await ctx.page.title()).toContain("Mimiri");
    }).toPass();
  });

  test("app reports the expected version", async () => {
    const userAgent = await ctx.page.evaluate(() => navigator.userAgent);
    expect(userAgent).toContain(`MimiriNotes/${ctx.version}`);
  });

  test("test seam reports the expected version", async () => {
    const info = await getTestInfo(ctx.page);
    test.skip(info === undefined, "app predates the test seam (< 2.6.5)");
    expect(info?.version).toBe(ctx.version);
    expect(info?.platform).toBe(process.platform);
    // Note: info.channel is deliberately NOT compared to the feed channel —
    // canary clients are built from the stable-bound bundle before promotion,
    // so the embedded channel always reads "stable".
  });

  test("window renders visible content", async () => {
    await expect(ctx.page.locator("body")).toBeVisible();
    const screenshot = await ctx.page.screenshot();
    expect(screenshot.length).toBeGreaterThan(0);
  });

  test("app process is still alive", async () => {
    expect(ctx.process.exitCode).toBeNull();
  });

  // The package format is not observable from inside the app (mimiriTestInfo
  // carries no format field and main-process eval is fused off in published
  // builds), so assert from the host side: flatpak knows which sandboxes it
  // is running.
  test("app runs inside the flatpak sandbox", async () => {
    test.skip(ctx.format !== "flatpak", "only meaningful for flatpak");
    const ps = spawnSync("flatpak", ["ps", "--columns=application"], {
      encoding: "utf8",
    });
    expect(ps.status).toBe(0);
    expect(ps.stdout).toContain(FLATPAK_APP_ID);
  });
});
