import { spawnSync } from "child_process";

/**
 * Drives real native file dialogs (NSOpenPanel) on macOS via System Events.
 *
 * Electron opens the panel as a sheet on the app's main window. We locate it
 * through the accessibility tree ("sheet 1 of window 1" of the app process,
 * addressed by pid), then drive it with the Go-to-Folder shortcut:
 * Cmd+Shift+G, type the absolute path, Return (navigate), Return (confirm
 * the default "Open" button).
 *
 * Requires the Automation (System Events) and Accessibility TCC permissions
 * for the process running the tests (for SSH sessions that is
 * sshd-keygen-wrapper) — nativeDialogSupport() probes for this and the spec
 * skips itself when the grant is missing.
 */

export interface MacNativeDialog {
  pid: number;
}

function osa(script: string): { ok: boolean; out: string } {
  const r = spawnSync("osascript", ["-e", script], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const procRef = (pid: number) =>
  `(first application process whose unix id is ${pid})`;

/** True when System Events keystroke automation is permitted. */
export function macDialogSupport(): boolean {
  const r = spawnSync(
    "osascript",
    ["-e", 'tell application "System Events" to keystroke ""'],
    { timeout: 15_000 },
  );
  return r.status === 0;
}

function sheetExists(pid: number): boolean {
  const r = osa(
    `tell application "System Events" to tell ${procRef(pid)} to exists sheet 1 of window 1`,
  );
  return r.ok && r.out === "true";
}

/** Clicks an item in the app's native menu bar (macOS builds only). */
export function clickNativeMenuItem(
  pid: number,
  menu: string,
  item: string,
): void {
  osa(
    `tell application "System Events" to set frontmost of ${procRef(pid)} to true`,
  );
  const r = osa(
    `tell application "System Events" to tell ${procRef(pid)} to click menu item "${item}" of menu "${menu}" of menu bar 1`,
  );
  if (!r.ok) {
    throw new Error(`could not click menu ${menu} > ${item}: ${r.out}`);
  }
}

/** Polls for the NSOpenPanel sheet on the app's main window. */
export async function waitForMacFileDialog(
  pid: number,
  timeoutMs = 15_000,
): Promise<MacNativeDialog> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (sheetExists(pid)) {
      return { pid };
    }
    await sleep(150);
  }
  throw new Error(`NSOpenPanel sheet did not appear within ${timeoutMs}ms`);
}

async function waitSheetGone(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!sheetExists(pid)) {
      return;
    }
    await sleep(150);
  }
  throw new Error("NSOpenPanel sheet did not close");
}

/** Waits for the Go-to-Folder sub-sheet to reach the wanted state. */
async function waitGotoSheet(
  pid: number,
  wanted: boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = osa(
      `tell application "System Events" to tell ${procRef(pid)} to exists sheet 1 of sheet 1 of window 1`,
    );
    if (r.ok && r.out === String(wanted)) {
      return;
    }
    await sleep(150);
  }
  throw new Error(
    `Go-to-Folder sheet did not ${wanted ? "appear" : "close"} in time`,
  );
}

/** Selects `dir` in an open directory-picker sheet. */
export async function selectMacDirectory(
  dialog: MacNativeDialog,
  dir: string,
): Promise<void> {
  const { pid } = dialog;
  osa(
    `tell application "System Events" to set frontmost of ${procRef(pid)} to true`,
  );
  await sleep(200);
  osa(
    `tell application "System Events" to keystroke "g" using {command down, shift down}`,
  );
  await waitGotoSheet(pid, true, 5_000);
  osa(`tell application "System Events" to keystroke "${dir}"`);
  await sleep(300);
  osa(`tell application "System Events" to key code 36`); // Return: navigate
  await waitGotoSheet(pid, false, 5_000);
  osa(`tell application "System Events" to key code 36`); // Return: confirm Open
  await waitSheetGone(pid, 8_000);
}

/** Dismisses the sheet with Escape (more robust than the Cancel button). */
export async function cancelMacDialog(dialog: MacNativeDialog): Promise<void> {
  const { pid } = dialog;
  osa(
    `tell application "System Events" to set frontmost of ${procRef(pid)} to true`,
  );
  await sleep(200);
  osa(`tell application "System Events" to key code 53`); // Escape
  await waitSheetGone(pid, 5_000);
}
