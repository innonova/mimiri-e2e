import fs from "fs";
import path from "path";
import { expect } from "@playwright/test";
import { AppContext, getTestInfo, versionAtLeast } from "./app";
import { clickNativeMenuItem } from "./native-dialog-mac";
import { enterLocalMode, createRootNote } from "./ui";

/**
 * Seeds and verifies "existing user" state for the upgrade-flow suite: a
 * nested note tree with known content plus a changed persisted setting,
 * created through the UI on the OLD version and asserted intact after
 * every upgrade hop.
 */

export interface SeededState {
  rootTitle: string;
  childTitle: string;
  grandchildTitle: string;
  /** Sentinel line typed into the grandchild's body. */
  content: string;
}

export const DEFAULT_SEED: SeededState = {
  rootTitle: "upgrade-root",
  childTitle: "upgrade-child",
  grandchildTitle: "upgrade-grandchild",
  content: "upgrade-sentinel-content",
};

/**
 * How the profile under test is isolated, which decides where the app
 * puts settings.config and bundles/:
 *
 * - flag: launchApp's default --user-data-dir=<root> (client >= 2.6.6) —
 *   everything lives directly under root.
 * - home: launchApp({homeIsolation: true}) — root acts as $HOME, data
 *   lives in <root>/.mimiri like on a real machine. Required whenever a
 *   profile must carry across a pre-2.6.6 shell, and the only layout old
 *   shells can produce.
 */
export interface ProfileLayout {
  kind: "flag" | "home";
  root: string;
}

/** Directory holding settings.config (and bundles/) for the layout. */
export function profileDataDir(layout: ProfileLayout): string {
  return layout.kind === "flag"
    ? layout.root
    : path.join(layout.root, ".mimiri");
}

/**
 * Pre-seeds settings.config for a PRE-SEAM (< 2.6.9) install, before its
 * first launch. Without seams the client runs its normal update flow
 * against the production host, and checkUpdateInitial() downloads and
 * activates the channel-pointer bundle whenever lastRunHostVersion
 * differs from the running shell — updateMode does NOT gate that branch.
 * Pre-seeding lastRunHostVersion to the installed version (exactly what
 * an existing user's profile holds) plus updateMode "off" makes the old
 * client leave its bundle state alone for the duration of the test.
 */
export function preSeedPreSeamProfile(
  layout: ProfileLayout,
  installedVersion: string,
): void {
  const dir = profileDataDir(layout);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "settings.config"),
    JSON.stringify(
      { updateMode: "off", lastRunHostVersion: installedVersion },
      undefined,
      "  ",
    ),
  );
}

const EDITOR_SELECTOR =
  '[data-testid="editor-prosemirror-container"] .ProseMirror, ' +
  '[data-testid="editor-monaco-container"] .monaco-editor';

async function typeIntoEditor(ctx: AppContext, text: string): Promise<void> {
  const editor = ctx.page.locator(EDITOR_SELECTOR).first();
  await editor.click();
  await ctx.page.keyboard.type(text);
  await ctx.page.keyboard.press(
    process.platform === "darwin" ? "Meta+s" : "Control+s",
  );
}

function noteInTree(ctx: AppContext, title: string) {
  return ctx.page.getByTestId("note-tree").getByTitle(title, { exact: true });
}

/** Creates a sub-note under the (selected) note titled `parentTitle`. */
async function createSubNote(
  ctx: AppContext,
  parentTitle: string,
  title: string,
): Promise<void> {
  await noteInTree(ctx, parentTitle).click();
  await ctx.page.getByTestId("toolbar-create-sub-note").click();
  const input = ctx.page.getByTestId("new-tree-node-input");
  await expect(input).toBeVisible();
  await input.fill(title);
  await input.press("Enter");
  await expect(noteInTree(ctx, title)).toBeVisible();
}

/**
 * Toggles dark mode via the View menu — a persisted setting reachable in
 * every version under test (menu item id `dark-mode`, present since well
 * before 2.6.1) that flips `theme` in settings.config immediately.
 */
async function toggleDarkMode(ctx: AppContext): Promise<void> {
  if (process.platform === "darwin") {
    if (ctx.process.pid === undefined) {
      throw new Error("app process has no pid");
    }
    await clickNativeMenuItem(ctx.process.pid, "View", "Dark Mode");
    return;
  }
  await ctx.page.getByTestId("title-menu-view").click();
  const item = ctx.page.getByTestId("menu-dark-mode");
  await expect(item).toBeVisible();
  await item.click();
}

function readSettings(layout: ProfileLayout): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(
      path.join(profileDataDir(layout), "settings.config"),
      "utf8",
    ),
  ) as Record<string, unknown>;
}

/**
 * Creates the seed state through the UI: root → child → grandchild notes,
 * sentinel content in the grandchild, dark theme toggled on. Ends by
 * asserting the theme change reached settings.config on disk, which also
 * fails fast if the layout's data dir is not where the app writes.
 */
export async function seedUserState(
  ctx: AppContext,
  layout: ProfileLayout,
  seed: SeededState = DEFAULT_SEED,
): Promise<void> {
  await enterLocalMode(ctx.page);
  await createRootNote(ctx, seed.rootTitle);
  await createSubNote(ctx, seed.rootTitle, seed.childTitle);
  await createSubNote(ctx, seed.childTitle, seed.grandchildTitle);
  await noteInTree(ctx, seed.grandchildTitle).click();
  await typeIntoEditor(ctx, seed.content);
  await toggleDarkMode(ctx);
  await expect(() => {
    expect(readSettings(layout).theme).toBe("dark");
  }).toPass({ timeout: 10_000 });
}

/**
 * Makes `title` visible in the tree, expanding its ancestors when the
 * expansion state did not survive the hop (dblclick on a node row toggles
 * it — TreeNode.vue). Ancestors outermost-first.
 */
async function revealInTree(
  ctx: AppContext,
  ancestors: string[],
  title: string,
): Promise<void> {
  const target = noteInTree(ctx, title);
  for (const ancestor of ancestors) {
    if (await target.isVisible()) {
      return;
    }
    const node = noteInTree(ctx, ancestor);
    if (await node.isVisible()) {
      await node.dblclick();
      await ctx.page.waitForTimeout(300);
    }
  }
  await expect(target).toBeVisible();
}

/**
 * Asserts the app is healthy on the expected versions with the seeded
 * state intact, and that it still works: notes present with content,
 * setting persisted, and a fresh note can be created and edited.
 */
export async function verifyUserState(
  ctx: AppContext,
  layout: ProfileLayout,
  expected: {
    shellVersion: string;
    /** Active bundle version, when a specific one must be running. */
    bundleVersion?: string;
    seed?: SeededState;
    /** Suffix distinguishing the post-upgrade note across multiple verify
     * steps in one scenario. */
    step?: string;
  },
): Promise<void> {
  const seed = expected.seed ?? DEFAULT_SEED;
  const { page } = ctx;
  await enterLocalMode(page);

  if (versionAtLeast(expected.shellVersion, 2, 6, 5)) {
    const info = await getTestInfo(page);
    expect(info?.version).toBe(expected.shellVersion);
  } else {
    const userAgent = await page.evaluate(() => navigator.userAgent);
    expect(userAgent).toContain(`MimiriNotes/${expected.shellVersion}`);
  }

  await expect(noteInTree(ctx, seed.rootTitle)).toBeVisible();
  await revealInTree(ctx, [seed.rootTitle], seed.childTitle);
  await revealInTree(
    ctx,
    [seed.rootTitle, seed.childTitle],
    seed.grandchildTitle,
  );
  await noteInTree(ctx, seed.grandchildTitle).click();
  await expect(page.locator(EDITOR_SELECTOR).first()).toContainText(
    seed.content,
    { timeout: 10_000 },
  );

  expect(readSettings(layout).theme).toBe("dark");

  if (expected.bundleVersion) {
    const config = JSON.parse(
      fs.readFileSync(
        path.join(profileDataDir(layout), "bundles", "config.json"),
        "utf8",
      ),
    ) as { activeVersion: string };
    expect(config.activeVersion).toBe(expected.bundleVersion);
  }

  // Still functional, not just readable: create and fill a fresh note.
  const freshTitle = `post-upgrade${expected.step ? `-${expected.step}` : ""}`;
  await createRootNote(ctx, freshTitle, `written on ${expected.shellVersion}`);
  await expect(noteInTree(ctx, freshTitle)).toBeVisible();

  expect(ctx.process.exitCode).toBeNull();
}
