import { test, expect } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";
import { launchApp, cleanup, loadMeta, AppContext } from "../helpers/app";
import {
  enterLocalMode,
  clickFileMenuItem,
  createRootNote,
  expectInfoDialog,
  dismissInfoDialog,
} from "../helpers/ui";
import {
  nativeDialogSupport,
  waitForFileDialog,
  acceptDirectoryTarget,
  cancelDialog,
  prepareDirectoryTarget,
  clearDirectoryTarget,
  isPortalDialog,
} from "../helpers/native-dialog";

/**
 * Exercises export/import through REAL native file dialogs.
 *
 * - Linux: dialogs are driven with xdotool, in both delivery modes (see
 *   dialogModes below). Requires the environment from
 *   scripts/run-with-dialogs.sh (X server, window manager, portals).
 * - macOS: NSOpenPanel sheets driven via System Events; requires the
 *   Automation + Accessibility TCC grants.
 * - Windows: the IFileDialog folder picker is driven via UI Automation.
 *
 * The suite skips itself where the platform prerequisites are missing, so
 * plain `npm test` stays green everywhere.
 *
 * Set MIMIRI_EXPECT_PORTAL=0 to allow a non-portal in-process GTK dialog on
 * Linux (e.g. on a desktop session without the portal stack).
 */

/**
 * Dialog delivery modes under test:
 * - "portal": the chooser is served over D-Bus by xdg-desktop-portal-gtk
 *   (a separate process). Chromium ≥ M145 always prefers this path when a
 *   FileChooser portal is reachable, so it is what most desktop users get
 *   regardless of package format — and sandboxed formats (flatpak, snap)
 *   can ONLY use it.
 * - "gtk": Electron's in-process GTK chooser — the fallback used on
 *   portal-less systems (minimal window managers, older distros). Since
 *   Chromium's portal probe is per-dialog and env-independent, the only
 *   way to exercise this path is to make the portal unreachable: the app
 *   gets a dead session-bus address. Only meaningful for the unsandboxed
 *   formats (tar.gz, AppImage).
 * Non-Linux platforms have a single native path and run once.
 */
type DialogMode = "portal" | "gtk";

function dialogModes(): {
  mode: DialogMode;
  launchEnv: Record<string, string>;
}[] {
  if (process.platform !== "linux") {
    return [{ mode: "portal", launchEnv: { GTK_USE_PORTAL: "1" } }];
  }
  let format = "targz";
  try {
    format = loadMeta().format ?? "targz";
  } catch {
    // no artifact fetched — the support guard below will skip the suite
  }
  if (format === "flatpak" || format === "snap") {
    return [{ mode: "portal", launchEnv: { GTK_USE_PORTAL: "1" } }];
  }
  return [
    { mode: "portal", launchEnv: { GTK_USE_PORTAL: "1" } },
    // "" means launchApp removes the variable from the app's environment
    // (run-with-dialogs.sh exports GTK_USE_PORTAL=1 into the test process).
    // The dead bus address makes the FileChooser portal unreachable, which
    // is the only remaining way to get the in-process GTK dialog.
    {
      mode: "gtk",
      launchEnv: {
        GTK_USE_PORTAL: "",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent-mimiri-e2e-bus",
      },
    },
  ];
}

for (const { mode, launchEnv } of dialogModes()) {
  const expectPortal =
    mode === "portal" &&
    process.platform === "linux" &&
    process.env.MIMIRI_EXPECT_PORTAL !== "0";

  test.describe(`export/import via native file dialogs (${mode})`, () => {
    test.skip(
      !nativeDialogSupport(),
      "needs linux + DISPLAY + xdotool (see scripts/run-with-dialogs.sh) " +
        "or macOS with automation permissions",
    );

    let ctx: AppContext;
    let workRoot: string;

    test.beforeAll(async () => {
      workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mimiri-dialogs-"));
      ctx = await launchApp({ env: launchEnv });
      await enterLocalMode(ctx.page);
      if (expectPortal) {
        // Warm up the portal: on a cold runner the first FileChooser
        // request can outrun the just-activated xdg-desktop-portal, and
        // GTK silently falls back to the in-process chooser — failing the
        // portal assertion (seen on the zero-retry nightly, even under
        // flatpak). Open and cancel one dialog, unasserted; the probe is
        // per-dialog, so the real tests then get the warmed portal.
        await clickFileMenuItem(ctx, "export-notes");
        const dialog = await waitForFileDialog({
          appPid: ctx.process.pid!,
          titleHint: "Export All Notes",
        });
        await cancelDialog(dialog);
      }
    });

    test.afterAll(async () => {
      await cleanup(ctx);
      clearDirectoryTarget();
      if (workRoot) {
        fs.rmSync(workRoot, { recursive: true, force: true });
      }
    });

    test.afterEach(() => {
      clearDirectoryTarget();
    });

    test("export all notes writes files through the native dialog", async () => {
      await createRootNote(ctx, "Export Source One", "alpha body text");
      await createRootNote(ctx, "Export Source Two");

      const exportDir = path.join(workRoot, "export-out");
      fs.mkdirSync(exportDir);
      prepareDirectoryTarget(exportDir);

      await clickFileMenuItem(ctx, "export-notes");
      const dialog = await waitForFileDialog({
        appPid: ctx.process.pid!,
        titleHint: "Export All Notes",
      });
      if (expectPortal) {
        expect(
          isPortalDialog(dialog),
          "dialog should be served via D-Bus portal",
        ).toBe(true);
      }
      if (mode === "gtk") {
        expect(
          isPortalDialog(dialog),
          "dialog should be the in-process GTK chooser, not the portal",
        ).toBe(false);
      }
      await acceptDirectoryTarget(dialog, exportDir);

      await expectInfoDialog(
        ctx.page,
        "Export All Notes",
        /Exported \d+ notes successfully/,
      );
      await dismissInfoDialog(ctx.page);

      const one = path.join(exportDir, "Export Source One.md");
      const two = path.join(exportDir, "Export Source Two.md");
      expect(fs.existsSync(one)).toBe(true);
      expect(fs.existsSync(two)).toBe(true);
      expect(fs.readFileSync(one, "utf8")).toContain("alpha body text");
    });

    test("import creates notes from a folder chosen in the native dialog", async () => {
      const importSrc = path.join(workRoot, "import-src");
      fs.mkdirSync(path.join(importSrc, "Nested"), { recursive: true });
      fs.writeFileSync(
        path.join(importSrc, "Alpha.md"),
        "alpha import content",
      );
      fs.writeFileSync(
        path.join(importSrc, "Bravo.md"),
        "bravo import content",
      );
      fs.writeFileSync(
        path.join(importSrc, "Nested", "Charlie.md"),
        "charlie import content",
      );
      prepareDirectoryTarget(importSrc);

      await clickFileMenuItem(ctx, "import-notes");
      const dialog = await waitForFileDialog({
        appPid: ctx.process.pid!,
        titleHint: "Import Notes",
      });
      if (expectPortal) {
        expect(
          isPortalDialog(dialog),
          "dialog should be served via D-Bus portal",
        ).toBe(true);
      }
      if (mode === "gtk") {
        expect(
          isPortalDialog(dialog),
          "dialog should be the in-process GTK chooser, not the portal",
        ).toBe(false);
      }
      await acceptDirectoryTarget(dialog, importSrc);

      await expectInfoDialog(
        ctx.page,
        "Import Notes",
        /Imported \d+ notes successfully/,
      );
      await dismissInfoDialog(ctx.page);

      // Imported notes land directly under a root note "Imported <timestamp>":
      // one note per .md/.txt file, plus subfolders as child notes.
      const tree = ctx.page.getByTestId("note-tree");
      const importedRoot = tree.getByTitle(/^Imported /);
      await expect(importedRoot).toBeVisible();
      await importedRoot.click();
      await ctx.page.keyboard.press("ArrowRight"); // expand root

      await expect(tree.getByTitle("Alpha", { exact: true })).toBeVisible();
      await expect(tree.getByTitle("Bravo", { exact: true })).toBeVisible();
      await expect(tree.getByTitle("Nested", { exact: true })).toBeVisible();
      await tree.getByTitle("Alpha", { exact: true }).click();
      await expect(
        ctx.page.locator(
          '[data-testid="editor-prosemirror-container"]:visible, ' +
            '[data-testid="editor-monaco-container"]:visible',
        ),
      ).toContainText("alpha import content");
    });

    test("cancelling the native dialog leaves the app healthy", async () => {
      const untouched = path.join(workRoot, "untouched");
      fs.mkdirSync(untouched);
      prepareDirectoryTarget(untouched);

      await clickFileMenuItem(ctx, "export-notes");
      const dialog = await waitForFileDialog({
        appPid: ctx.process.pid!,
        titleHint: "Export All Notes",
      });
      await cancelDialog(dialog);

      // No success (or any) dialog appears, nothing is written, app stays sane.
      await expect(ctx.page.getByTestId("info-dialog")).not.toBeVisible();
      await expect(ctx.page.getByTestId("app-status")).toHaveValue("ready");
      expect(fs.readdirSync(untouched)).toHaveLength(0);
      expect(ctx.process.exitCode).toBeNull();

      // The UI is still interactive: a fresh dialog can be opened and closed.
      await clickFileMenuItem(ctx, "export-notes");
      const again = await waitForFileDialog({
        appPid: ctx.process.pid!,
        titleHint: "Export All Notes",
      });
      await cancelDialog(again);
    });
  });
}
