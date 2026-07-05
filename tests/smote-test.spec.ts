import { test, expect } from "@playwright/test";
import { launchApp } from "../helpers/app";

test.describe("sharing flow", () => {
  let ctx: Awaited<ReturnType<typeof launchApp>>;

  test.beforeAll(async () => {
    ctx = await launchApp();
    const win = await ctx.app.firstWindow();
  });

  test.afterAll(async () => ctx?.app.close());
});
