import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";

/**
 * Helpers for the macOS shell (Squirrel.Mac) update test. Unlike Windows,
 * the update payload cannot be a repacked fixture — Squirrel.Mac validates
 * the code signature of the replacement app — so the test updates between
 * two REAL signed releases: a pinned base version is extracted to a temp
 * dir (Squirrel.Mac swaps the .app in place, wherever it lives) and updated
 * to the fetched artifact's version.
 */

/**
 * The release the mac shell-update test starts from — the first with the
 * MIMIRI_UPDATE_URL/MIMIRI_UPDATE_KEY seams. Kept downloadable forever on
 * the update host, so the test works regardless of the current version.
 */
export const MAC_SHELL_BASE_VERSION = "2.6.9";

export const MAC_APP_BUNDLE = "Mimiri Notes.app";

/** Downloaded darwin zips for the base and update versions. */
export function macShellArtifacts(currentVersion: string): {
  baseZip: string;
  updateZip: string;
} {
  const downloads = path.resolve("artifacts", "downloads");
  const zipName = (v: string) => `Mimiri Notes-darwin-universal-${v}.zip`;
  return {
    baseZip: path.join(downloads, zipName(MAC_SHELL_BASE_VERSION)),
    updateZip: path.join(downloads, zipName(currentVersion)),
  };
}

/**
 * Extracts a darwin zip into destDir (ditto preserves the signed .app
 * structure) and returns the app executable path.
 */
export function extractMacApp(zipPath: string, destDir: string): string {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  const result = spawnSync("ditto", ["-xk", zipPath, destDir], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`ditto -xk failed: ${result.stderr}`);
  }
  return path.join(
    destDir,
    MAC_APP_BUNDLE,
    "Contents",
    "MacOS",
    "mimiri-notes",
  );
}

/** CFBundleShortVersionString of an .app bundle, or undefined. */
export function macAppVersion(appBundle: string): string | undefined {
  const result = spawnSync(
    "plutil",
    [
      "-extract",
      "CFBundleShortVersionString",
      "raw",
      path.join(appBundle, "Contents", "Info.plist"),
    ],
    { encoding: "utf8" },
  );
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** CFBundleIdentifier of an .app bundle, or undefined. */
export function macAppBundleId(appBundle: string): string | undefined {
  const result = spawnSync(
    "plutil",
    [
      "-extract",
      "CFBundleIdentifier",
      "raw",
      path.join(appBundle, "Contents", "Info.plist"),
    ],
    { encoding: "utf8" },
  );
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** Whether any process is running from under `dir` (e.g. the temp .app). */
export function processRunningUnder(dir: string): boolean {
  const result = spawnSync("pgrep", ["-f", dir], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim().length > 0;
}

/** Force-kills every process running from under `dir`. */
export function killProcessesUnder(dir: string): void {
  spawnSync("pkill", ["-9", "-f", dir], { stdio: "ignore" });
}

/** Best-effort removal of Squirrel.Mac's staging cache for the app. */
export function cleanShipItCache(bundleId: string | undefined): void {
  if (!bundleId) {
    return;
  }
  const caches = path.join(process.env.HOME ?? "", "Library", "Caches");
  for (const suffix of [".ShipIt", ".ShipItStaging"]) {
    fs.rmSync(path.join(caches, `${bundleId}${suffix}`), {
      recursive: true,
      force: true,
    });
  }
}
