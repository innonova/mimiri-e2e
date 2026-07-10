import { spawn, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Helpers for driving a real Squirrel.Windows install of Mimiri Notes.
 * The in-app shell updater (electron's autoUpdater) only works from a
 * Squirrel-installed layout — %LOCALAPPDATA%\mimiri_notes\Update.exe next
 * to app-<version>\ — so the shell-update e2e test installs the published
 * Setup.exe for real and updates it to a repacked higher-version nupkg.
 */

/** NuGet package id — the Squirrel install dir under %LOCALAPPDATA%. */
const PACKAGE_ID = "mimiri_notes";

export const APP_EXE_NAME = "Mimiri Notes.exe";

/** System bsdtar — handles both zip extraction and zip creation. */
const TAR = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "tar.exe",
);

export function squirrelRoot(): string {
  const localAppData =
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, PACKAGE_ID);
}

/** Downloaded-artifact paths for a version (written by fetch-artifact). */
export function winShellArtifacts(version: string): {
  nupkg: string;
  setupExe: string;
} {
  const downloads = path.resolve("artifacts", "downloads");
  return {
    nupkg: path.join(downloads, `mimiri_notes-${version}-full.nupkg`),
    setupExe: path.join(downloads, `Mimiri Notes-${version} Setup.exe`),
  };
}

function run(cmd: string, args: string[], what: string): void {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${what} exited with status ${result.status}: ${result.stderr}`,
    );
  }
}

/**
 * Repacks a Squirrel full nupkg under a new version: extracts it, bumps the
 * <version> in the .nuspec (which determines the app-<version> install dir
 * Squirrel uses), and zips it back up. The binaries are unchanged — the
 * point is exercising the update *mechanism*, and Squirrel only trusts the
 * SHA1 from the RELEASES line, which the mock server computes from this
 * file. Cached under artifacts/shell-update/.
 */
export function repackNupkg(nupkgPath: string, newVersion: string): string {
  const outDir = path.resolve("artifacts", "shell-update");
  const outFile = path.join(outDir, `${PACKAGE_ID}-${newVersion}-full.nupkg`);
  if (fs.existsSync(outFile)) {
    return outFile;
  }
  const extractDir = path.join(outDir, "repack");
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  run(TAR, ["-xf", nupkgPath, "-C", extractDir], "nupkg extract");

  const nuspec = fs
    .readdirSync(extractDir)
    .find((name) => name.endsWith(".nuspec"));
  if (!nuspec) {
    throw new Error(`no .nuspec found in ${nupkgPath}`);
  }
  const nuspecPath = path.join(extractDir, nuspec);
  const xml = fs.readFileSync(nuspecPath, "utf8");
  const bumped = xml.replace(
    /<version>[^<]+<\/version>/,
    `<version>${newVersion}</version>`,
  );
  if (bumped === xml) {
    throw new Error(`no <version> element found in ${nuspec}`);
  }
  fs.writeFileSync(nuspecPath, bumped);

  const entries = fs.readdirSync(extractDir);
  run(
    TAR,
    ["--format", "zip", "-cf", outFile, "-C", extractDir, ...entries],
    "nupkg repack",
  );
  fs.rmSync(extractDir, { recursive: true, force: true });
  return outFile;
}

/** Full paths of running Mimiri Notes processes. */
export function runningAppPaths(): string[] {
  const result = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `(Get-Process -Name 'Mimiri Notes' -ErrorAction SilentlyContinue).Path`,
    ],
    { encoding: "utf8" },
  );
  return (result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Force-kills every running Mimiri Notes instance (and child processes). */
export function killAppInstances(): void {
  spawnSync("taskkill", ["/IM", APP_EXE_NAME, "/T", "/F"], {
    stdio: "ignore",
  });
}

export async function waitForCondition(
  what: string,
  condition: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${what} (${timeoutMs}ms)`);
}

/**
 * Installs the app for real via the published Squirrel Setup.exe (silent).
 * Setup auto-launches the app after installing; the caller decides when to
 * kill it. Returns the path of the installed app executable.
 */
export async function installSquirrelApp(
  setupExePath: string,
  version: string,
): Promise<string> {
  const root = squirrelRoot();
  const appExe = path.join(root, `app-${version}`, APP_EXE_NAME);
  // A leftover install is stale global state — clear it first.
  uninstallSquirrelApp();
  const setup = spawn(setupExePath, ["--silent"], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    setup.on("exit", () => resolve());
    setup.on("error", reject);
  });
  await waitForCondition(
    "Squirrel install to finish",
    () => fs.existsSync(path.join(root, "Update.exe")) && fs.existsSync(appExe),
    120_000,
  );
  // Give the auto-launched instance a moment to settle, then kill it —
  // the test relaunches the app itself with the debug port and env seams.
  await waitForCondition(
    "auto-launched app",
    () => runningAppPaths().length > 0,
    60_000,
  ).catch(() => {
    // Some Setup versions may not auto-launch — that's fine.
  });
  killAppInstances();
  await waitForCondition(
    "app to exit",
    () => runningAppPaths().length === 0,
    30_000,
  );
  return appExe;
}

/** Uninstalls (best effort) and removes the Squirrel install dir. */
export function uninstallSquirrelApp(): void {
  killAppInstances();
  const updateExe = path.join(squirrelRoot(), "Update.exe");
  if (fs.existsSync(updateExe)) {
    spawnSync(updateExe, ["--uninstall", "-s"], { stdio: "ignore" });
  }
  fs.rmSync(squirrelRoot(), { recursive: true, force: true });
}
