import { test, expect } from "@playwright/test";
import { spawnSync } from "child_process";
import { launchApp, cleanup, versionAtLeast, AppContext } from "../helpers/app";
import { enterLocalMode } from "../helpers/ui";
import {
  macDialogSupport,
  clickNativeMenuItem,
  listNativeMenus,
  listNativeMenuItems,
  pressNativeShortcut,
} from "../helpers/native-dialog-mac";

/**
 * The macOS native menu bar. The mac build replaces Electron's default
 * application menu with a custom, role-less template built by the client
 * (mimiri-client `menu-manager.ts` → shell `setAppMenu`). Two things have
 * regressed there before and are pinned here:
 *
 * - Cmd+X/C/V: the custom Edit items claim the accelerators, so unless the
 *   app forwards them, text fields outside the note editor (login password,
 *   PIN) silently lose paste. Shell 2.6.21 added `menu.nativeAction`
 *   (webContents cut/copy/paste); bundle 2.6.22 routes the menu items
 *   through it. A user reported the login password not accepting paste.
 * - The standard macOS entries (Services, Hide, Hide Others, Show All, the
 *   Window menu) were simply absent until bundle 2.6.23 added them via
 *   Electron roles (which the shell accepts since 2.6.21).
 *
 * The menu is driven for real through System Events (same TCC grants as the
 * native dialog tests), so the suite skips itself where those are missing.
 * The client bundle is a separate stream from the shell: the shell version
 * is `ctx.version`; the bundle version is read from the login dialog.
 */

const APP_MENU = "Mimiri Notes";

/** Bundle 2.6.22: login-dialog quit hint + menu paste into text fields. */
const bundleHasNativePaste = (v: string) => versionAtLeast(v, 2, 6, 22);
/** Bundle 2.6.23 + shell 2.6.21: standard macOS menu entries via roles. */
const bundleHasStandardMenus = (v: string) => versionAtLeast(v, 2, 6, 23);
const shellHasMenuRoles = (v: string) => versionAtLeast(v, 2, 6, 21);

function setClipboard(text: string): void {
  const r = spawnSync("pbcopy", { input: text });
  if (r.status !== 0) {
    throw new Error(`pbcopy failed: ${r.stderr}`);
  }
}

test.describe("mac native menu", () => {
  test.skip(process.platform !== "darwin", "macOS-only");
  test.skip(!macDialogSupport(), "System Events automation not permitted");

  let ctx: AppContext;
  let pid: number;
  /** Version of the client bundle actually running (not the shell). */
  let bundleVersion: string;

  test.beforeAll(async () => {
    ctx = await launchApp();
    if (ctx.process.pid === undefined) {
      throw new Error("app process has no pid");
    }
    pid = ctx.process.pid;
    await enterLocalMode(ctx.page);
    // The login dialog shows the running bundle version in its corner; it
    // also hosts the password field the paste tests target, so keep it open.
    await clickNativeMenuItem(pid, APP_MENU, "Log In / Switch User");
    await expect(ctx.page.getByTestId("login-dialog")).toBeVisible();
    const version = ctx.page.getByText(/^v \d+\.\d+\.\d+$/);
    await expect(version).toBeVisible();
    bundleVersion = (await version.textContent())!.replace(/^v /, "");
    test.info().annotations.push({
      type: "bundle-version",
      description: bundleVersion,
    });
  });

  test.afterAll(async () => {
    await cleanup(ctx);
  });

  test("application menu carries the standard macOS entries", async () => {
    test.skip(
      !shellHasMenuRoles(ctx.version),
      `shell ${ctx.version} predates menu roles (< 2.6.21)`,
    );
    test.skip(
      !bundleHasStandardMenus(bundleVersion),
      `bundle ${bundleVersion} predates the standard menu entries (< 2.6.23)`,
    );
    const items = await listNativeMenuItems(pid, APP_MENU);
    expect(items).toEqual(
      expect.arrayContaining([
        "About",
        "Services",
        "Hide Mimiri Notes",
        "Hide Others",
        "Show All",
        "Quit",
      ]),
    );
    // Quit stays last, after the OS-provided block.
    expect(items[items.length - 1]).toBe("Quit");
  });

  test("Window menu exists with the standard entries", async () => {
    test.skip(
      !shellHasMenuRoles(ctx.version),
      `shell ${ctx.version} predates menu roles (< 2.6.21)`,
    );
    test.skip(
      !bundleHasStandardMenus(bundleVersion),
      `bundle ${bundleVersion} predates the standard menu entries (< 2.6.23)`,
    );
    const menus = await listNativeMenus(pid);
    expect(menus).toEqual(
      expect.arrayContaining([
        APP_MENU,
        "File",
        "Edit",
        "View",
        "Window",
        "Help",
      ]),
    );
    const items = await listNativeMenuItems(pid, "Window");
    expect(items).toEqual(
      expect.arrayContaining(["Minimize", "Zoom", "Bring All to Front"]),
    );
  });

  test("Edit menu keeps Cut / Copy / Paste", async () => {
    const items = await listNativeMenuItems(pid, "Edit");
    expect(items).toEqual(expect.arrayContaining(["Cut", "Copy", "Paste"]));
  });

  test("login dialog explains that quitting signs out", async () => {
    test.skip(
      !bundleHasNativePaste(bundleVersion),
      `bundle ${bundleVersion} predates the quit hint (< 2.6.22)`,
    );
    await expect(ctx.page.getByTestId("quit-hint")).toBeVisible();
  });

  test("Edit > Paste pastes into the login password field", async () => {
    test.skip(
      !bundleHasNativePaste(bundleVersion),
      `bundle ${bundleVersion} predates menu paste into text fields (< 2.6.22)`,
    );
    const password = ctx.page.getByTestId("password-input");
    await password.fill("");
    await password.focus();
    setClipboard("menu-pasted-secret");
    await clickNativeMenuItem(pid, "Edit", "Paste");
    await expect(password).toHaveValue("menu-pasted-secret");
  });

  test("Cmd+V pastes into the login password field", async () => {
    test.skip(
      !bundleHasNativePaste(bundleVersion),
      `bundle ${bundleVersion} predates menu paste into text fields (< 2.6.22)`,
    );
    const password = ctx.page.getByTestId("password-input");
    await password.fill("");
    await password.focus();
    setClipboard("shortcut-pasted-secret");
    await pressNativeShortcut(pid, "v", ["command"]);
    await expect(password).toHaveValue("shortcut-pasted-secret");
  });

  test("Edit > Copy copies from the username field", async () => {
    test.skip(
      !bundleHasNativePaste(bundleVersion),
      `bundle ${bundleVersion} predates menu copy from text fields (< 2.6.22)`,
    );
    const username = ctx.page.getByTestId("username-input");
    await username.fill("copy-me-user");
    await username.focus();
    await username.selectText();
    setClipboard("clipboard-reset");
    await clickNativeMenuItem(pid, "Edit", "Copy");
    await expect(async () => {
      const r = spawnSync("pbpaste", { encoding: "utf8" });
      expect(r.stdout).toBe("copy-me-user");
    }).toPass();
  });
});
