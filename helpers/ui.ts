import { Page, expect } from "@playwright/test";
import { AppContext } from "./app";
import { clickNativeMenuItem } from "./native-dialog-mac";

/**
 * Small drivers for the app UI over the CDP-attached page, based on the
 * client's data-testid conventions (see mimiri-client).
 */

/** File-menu labels in the macOS native menu bar, by DOM menu item id. */
const MAC_FILE_MENU_LABELS: Record<string, string> = {
  "new-root-note": "New Root Note",
  "export-notes": "Export All Notes",
  "import-notes": "Import Notes",
};

/**
 * Gets the app into a usable local-account session. On a fresh profile the
 * app auto-opens a local account; if the login dialog shows instead, cancel
 * falls back to the same local account. Either way isLoggedIn becomes true,
 * which enables the export/import menu items.
 */
export async function enterLocalMode(page: Page): Promise<void> {
  const loginDialog = page.getByTestId("login-dialog");
  const status = page.getByTestId("app-status");
  await expect(async () => {
    expect(
      (await loginDialog.isVisible()) ||
        (await status.inputValue()) === "ready",
    ).toBe(true);
  }).toPass({ timeout: 30_000 });
  if (await loginDialog.isVisible()) {
    await page.getByTestId("cancel-button").click();
    await expect(loginDialog).not.toBeVisible();
  }
  await expect(status).toHaveValue("ready", { timeout: 30_000 });
  await expect(page.getByTestId("note-tree")).toBeVisible();
}

/**
 * Clicks a File-menu item. On Linux/Windows the menu is a custom DOM
 * titlebar; on macOS builds it is the native menu bar, driven through
 * System Events.
 */
export async function clickFileMenuItem(
  ctx: AppContext,
  itemId: string,
): Promise<void> {
  if (process.platform === "darwin") {
    const label = MAC_FILE_MENU_LABELS[itemId];
    if (!label) {
      throw new Error(`no macOS menu label known for item id "${itemId}"`);
    }
    if (ctx.process.pid === undefined) {
      throw new Error("app process has no pid");
    }
    clickNativeMenuItem(ctx.process.pid, "File", label);
    return;
  }
  await ctx.page.getByTestId("title-menu-file").click();
  const item = ctx.page.getByTestId(`menu-${itemId}`);
  await expect(item).toBeVisible();
  await item.click();
}

/** Creates a root note via the File menu, optionally typing body content. */
export async function createRootNote(
  ctx: AppContext,
  title: string,
  content?: string,
): Promise<void> {
  const { page } = ctx;
  await clickFileMenuItem(ctx, "new-root-note");
  const input = page.getByTestId("new-tree-node-input");
  await expect(input).toBeVisible();
  await input.fill(title);
  await input.press("Enter");
  await expect(
    page.getByTestId("note-tree").getByTitle(title, { exact: true }),
  ).toBeVisible();
  if (content) {
    const editor = page
      .locator(
        '[data-testid="editor-prosemirror-container"] .ProseMirror, ' +
          '[data-testid="editor-monaco-container"] .monaco-editor',
      )
      .first();
    await editor.click();
    await page.keyboard.type(content);
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+s" : "Control+s",
    );
  }
}

/** Asserts the info dialog is shown with the given title and body. */
export async function expectInfoDialog(
  page: Page,
  title: string | RegExp,
  body: RegExp,
): Promise<void> {
  const dialog = page.getByTestId("info-dialog");
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("info-dialog-title")).toHaveText(title);
  await expect(dialog).toContainText(body);
}

export async function dismissInfoDialog(page: Page): Promise<void> {
  await page.getByTestId("info-dialog-ok").click();
  await expect(page.getByTestId("info-dialog")).not.toBeVisible();
}
