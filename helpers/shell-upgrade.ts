import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { extractMacApp, MAC_APP_BUNDLE } from "./mac-squirrel";
import { installSquirrelApp, winShellArtifacts } from "./win-squirrel";

/**
 * Simulates the "user downloads a build from the website and installs it"
 * path, for a fresh install and for installing a newer version over an
 * existing one:
 *
 * - Linux targz: extract the tarball; upgrading replaces the app dir.
 * - macOS: extract the zip; upgrading replaces the .app bundle in place.
 *   (Our downloads carry no quarantine xattr, so Gatekeeper isn't in the
 *   loop — its concerns are covered by the signing assertions instead.)
 * - Windows: run the version's real Setup.exe; upgrading runs the newer
 *   Setup.exe over the existing Squirrel installation.
 *
 * install/upgrade return the app executable path for launchApp's
 * executablePath override.
 */

function linuxArch(): string {
  return process.arch === "arm64" ? "arm64" : "amd64";
}

/** Downloaded archive for a version on the current platform (targz form). */
export function shellArchivePath(version: string): string {
  const downloads = path.resolve("artifacts", "downloads");
  switch (process.platform) {
    case "linux":
      return path.join(
        downloads,
        `mimiri-notes_${version}_${linuxArch()}.tar.gz`,
      );
    case "darwin":
      return path.join(
        downloads,
        `Mimiri Notes-darwin-universal-${version}.zip`,
      );
    case "win32":
      return winShellArtifacts(version).setupExe;
    default:
      throw new Error(`unsupported platform: ${process.platform}`);
  }
}

function extractTarGz(archive: string, workDir: string): string {
  const appDir = path.join(workDir, "mimiri-notes");
  fs.rmSync(appDir, { recursive: true, force: true });
  const result = spawnSync("tar", ["-xf", archive, "-C", workDir], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`tar -xf failed: ${result.stderr}`);
  }
  return path.join(appDir, "mimiri-notes");
}

/** Installs `version` into workDir (Windows: the real Squirrel location). */
export async function installShell(
  version: string,
  workDir: string,
): Promise<string> {
  const archive = shellArchivePath(version);
  switch (process.platform) {
    case "linux":
      return extractTarGz(archive, workDir);
    case "darwin":
      return extractMacApp(archive, workDir);
    case "win32":
      return installSquirrelApp(archive, version);
    default:
      throw new Error(`unsupported platform: ${process.platform}`);
  }
}

/** Installs `version` OVER the existing installation in workDir. */
export async function upgradeShell(
  version: string,
  workDir: string,
): Promise<string> {
  const archive = shellArchivePath(version);
  switch (process.platform) {
    case "linux":
      return extractTarGz(archive, workDir);
    case "darwin": {
      // Real users replace the .app; ditto into a clean bundle location.
      fs.rmSync(path.join(workDir, MAC_APP_BUNDLE), {
        recursive: true,
        force: true,
      });
      return extractMacApp(archive, workDir);
    }
    case "win32":
      return installSquirrelApp(archive, version, { over: true });
    default:
      throw new Error(`unsupported platform: ${process.platform}`);
  }
}
