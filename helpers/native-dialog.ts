import {
  linuxDialogSupport,
  waitForFileDialog as waitLinux,
  acceptBookmarkedDirectory,
  cancelDialog as cancelLinux,
  setDirectoryBookmark,
  clearDirectoryBookmark,
  LinuxNativeDialog,
} from "./native-dialog-linux";
import {
  macDialogSupport,
  waitForMacFileDialog,
  selectMacDirectory,
  cancelMacDialog,
  MacNativeDialog,
} from "./native-dialog-mac";

/**
 * Platform dispatcher for driving REAL native file dialogs.
 *
 * - Linux: GTK dialogs routed through xdg-desktop-portal (D-Bus) when the
 *   app runs with GTK_USE_PORTAL=1; driven with xdotool via a temporary GTK
 *   places bookmark. Needs the scripts/run-with-dialogs.sh environment.
 * - macOS: NSOpenPanel sheets driven through System Events (Cmd+Shift+G).
 *   Needs the Automation + Accessibility TCC grants.
 * - Windows: not implemented yet.
 */

export type NativeDialog =
  | ({ platform: "linux" } & LinuxNativeDialog)
  | ({ platform: "darwin" } & MacNativeDialog);

/** True when this machine can drive native dialogs (test skip guard). */
export function nativeDialogSupport(): boolean {
  if (process.platform === "linux") {
    return linuxDialogSupport();
  }
  if (process.platform === "darwin") {
    return macDialogSupport();
  }
  return false;
}

/**
 * Registers `dir` as the pick target before the dialog opens. On Linux this
 * writes the GTK bookmark the driver later clicks; on macOS it is a no-op
 * (the path is typed into the Go-to-Folder sheet instead).
 */
export function prepareDirectoryTarget(dir: string): void {
  if (process.platform === "linux") {
    setDirectoryBookmark(dir);
  }
}

/** Removes state left by prepareDirectoryTarget(). */
export function clearDirectoryTarget(): void {
  if (process.platform === "linux") {
    clearDirectoryBookmark();
  }
}

/**
 * Waits for the native directory-picker to appear. `appPid` is the app's
 * process id (needed on macOS to address the sheet); `titleHint` helps the
 * Linux fallback search.
 */
export async function waitForFileDialog(opts: {
  appPid: number;
  titleHint?: string;
  timeoutMs?: number;
}): Promise<NativeDialog> {
  if (process.platform === "linux") {
    const d = await waitLinux({
      titleHint: opts.titleHint,
      timeoutMs: opts.timeoutMs,
    });
    return { platform: "linux", ...d };
  }
  if (process.platform === "darwin") {
    const d = await waitForMacFileDialog(opts.appPid, opts.timeoutMs);
    return { platform: "darwin", ...d };
  }
  throw new Error(`native dialogs not supported on ${process.platform}`);
}

/** Chooses the directory registered with prepareDirectoryTarget(). */
export async function acceptDirectoryTarget(
  dialog: NativeDialog,
  dir: string,
): Promise<void> {
  if (dialog.platform === "linux") {
    await acceptBookmarkedDirectory(dialog);
  } else {
    await selectMacDirectory(dialog, dir);
  }
}

/** Dismisses the dialog without choosing anything. */
export async function cancelDialog(dialog: NativeDialog): Promise<void> {
  if (dialog.platform === "linux") {
    await cancelLinux(dialog);
  } else {
    await cancelMacDialog(dialog);
  }
}

/** True when the dialog was rendered by the xdg portal (Linux D-Bus path). */
export function isPortalDialog(dialog: NativeDialog): boolean {
  return dialog.platform === "linux" && dialog.viaPortal;
}
