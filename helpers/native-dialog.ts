import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Drives real native file dialogs on Linux via xdotool.
 *
 * With GTK_USE_PORTAL=1 the app's GTK file chooser is rendered by
 * xdg-desktop-portal-gtk in its own process (reached over D-Bus), so the
 * dialog is a normal top-level X window we can find by WM_CLASS.
 *
 * The app's export/import dialogs are directory pickers. Driving a GTK
 * directory chooser reliably under Xvfb is hard: the Ctrl+L location entry
 * aggressively auto-completes and never commits, and the file list renders
 * unusably under software rasterization. What IS reliable is the places
 * sidebar — clicking a GTK bookmark navigates straight into that folder and
 * enables the Select button (which chooses the current folder). So we add a
 * temporary sidebar bookmark for the target directory, click it, then click
 * Select.
 *
 * Input uses windowactivate + global XTEST events (synthetic per-window
 * events are unreliable with GTK), which requires a running window manager —
 * scripts/run-with-dialogs.sh provides openbox.
 */

export interface NativeDialog {
  windowId: string;
  /** True when the dialog is rendered by xdg-desktop-portal-gtk (D-Bus path). */
  viaPortal: boolean;
  geometry: { x: number; y: number; width: number; height: number };
}

const BOOKMARKS_FILE = path.join(
  os.homedir(),
  ".config",
  "gtk-3.0",
  "bookmarks",
);
const BOOKMARK_LABEL = "MIMIRI-E2E-TARGET";

function xdo(...args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("xdotool", args, { encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True when xdotool + an X display are available (test skip guard). */
export function nativeDialogSupport(): boolean {
  return (
    process.platform === "linux" &&
    !!process.env.DISPLAY &&
    spawnSync("xdotool", ["version"]).status === 0
  );
}

/**
 * Makes `dir` the single sidebar bookmark so the dialog's places list shows
 * exactly one user bookmark at a known position. Must be called BEFORE the
 * dialog is opened — xdg-desktop-portal-gtk reads the bookmarks file when a
 * dialog opens. Call clearDirectoryBookmark() afterwards.
 */
export function setDirectoryBookmark(dir: string): void {
  fs.mkdirSync(path.dirname(BOOKMARKS_FILE), { recursive: true });
  fs.writeFileSync(BOOKMARKS_FILE, `file://${dir} ${BOOKMARK_LABEL}\n`);
}

export function clearDirectoryBookmark(): void {
  fs.rmSync(BOOKMARKS_FILE, { force: true });
}

function readGeometry(windowId: string): NativeDialog["geometry"] {
  const out = spawnSync("xdotool", ["getwindowgeometry", "--shell", windowId], {
    encoding: "utf8",
  }).stdout;
  const g: Record<string, number> = {};
  for (const line of out.split("\n")) {
    const m = line.match(/^(\w+)=(\d+)$/);
    if (m) g[m[1]] = Number(m[2]);
  }
  return {
    x: g.X ?? 0,
    y: g.Y ?? 0,
    width: g.WIDTH ?? 0,
    height: g.HEIGHT ?? 0,
  };
}

/**
 * Polls for the file-chooser window. Prefers the portal window (by
 * WM_CLASS); falls back to matching the dialog title, which also covers a
 * non-portal in-process GTK dialog.
 */
export async function waitForFileDialog(
  opts: { titleHint?: string; timeoutMs?: number } = {},
): Promise<NativeDialog> {
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  while (Date.now() < deadline) {
    let windowId: string | undefined;
    let viaPortal = false;
    const portal = xdo(
      "search",
      "--onlyvisible",
      "--class",
      "xdg-desktop-portal-gtk",
    );
    if (portal.ok && portal.out) {
      windowId = portal.out.split("\n").filter(Boolean).pop();
      viaPortal = true;
    } else if (opts.titleHint) {
      const byName = xdo("search", "--onlyvisible", "--name", opts.titleHint);
      if (byName.ok && byName.out) {
        windowId = byName.out.split("\n").filter(Boolean).pop();
      }
    }
    if (windowId) {
      xdo("windowactivate", "--sync", windowId);
      await sleep(400);
      return { windowId, viaPortal, geometry: readGeometry(windowId) };
    }
    await sleep(100);
  }
  throw new Error(
    `native file dialog did not appear within ${opts.timeoutMs ?? 15_000}ms` +
      (opts.titleHint ? ` (title hint: ${opts.titleHint})` : ""),
  );
}

async function waitGone(windowId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!xdo("getwindowname", windowId).ok) {
      return;
    }
    await sleep(100);
  }
  throw new Error("native file dialog did not close");
}

function click(x: number, y: number): void {
  xdo("mousemove", String(x), String(y));
  xdo("click", "1");
}

/**
 * Chooses the directory bookmarked via setDirectoryBookmark(): clicks the
 * single user bookmark in the places sidebar (which navigates into it), then
 * clicks Select. The sidebar layout under this harness is fixed — Recent,
 * Home, Desktop, the current-folder shortcut, then the one bookmark — so the
 * bookmark sits a known distance below the window's top.
 */
export async function acceptBookmarkedDirectory(
  dialog: NativeDialog,
): Promise<void> {
  const { x, y, width, height } = dialog.geometry;
  xdo("windowactivate", "--sync", dialog.windowId);
  // Click the sole user bookmark in the sidebar.
  click(x + 70, y + 162);
  await sleep(800);
  // Click Select (bottom-right) to choose the now-current folder.
  click(x + width - 47, y + height - 27);
  await waitGone(dialog.windowId, 8_000);
}

/** Dismisses the dialog with Escape. */
export async function cancelDialog(dialog: NativeDialog): Promise<void> {
  xdo("windowactivate", "--sync", dialog.windowId);
  xdo("key", "--clearmodifiers", "Escape");
  await waitGone(dialog.windowId, 5_000);
}
