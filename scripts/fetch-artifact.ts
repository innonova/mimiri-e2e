/**
 * Fetches the packaged Mimiri Notes Electron app and prepares it under
 * `artifacts/<version>` so the e2e suite has something to launch.
 *
 * Usage:
 *   npm run fetch                            # latest stable
 *   npm run fetch -- canary                  # latest canary
 *   npm run fetch -- 2.6.1                   # explicit version
 *   npm run fetch -- canary --format=flatpak # a specific Linux package format
 *
 * Supported platforms: Windows (.nupkg), macOS (.zip) and Linux
 * (tar.gz, flatpak, AppImage — selected with --format, default targz).
 */
import path from "path";
import fs from "fs";
import { spawnSync } from "child_process";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import {
  AppFormat,
  ArtifactMeta,
  FLATPAK_APP_ID,
  SNAP_NAME,
  resolveFormat,
} from "../helpers/format";
import {
  Bundle,
  PRODUCTION_UPDATE_PUBLIC_KEY,
  UPDATE_KEY_NAME,
  verifyBundleSignature,
} from "../helpers/bundle-crypto";

const UPDATE_HOST = "https://update.mimiri.io";
const ARTIFACTS_DIR = path.resolve("artifacts");
const DOWNLOADS_DIR = path.join(ARTIFACTS_DIR, "downloads");

interface FeedLink {
  url: string;
  name: string;
}

interface FeedSystem {
  name: string;
  links: FeedLink[];
  canary?: FeedLink[];
  stable?: FeedLink[];
}

interface Feed {
  systems: FeedSystem[];
}

function linuxArch(): string {
  return process.arch === "arm64" ? "arm64" : "amd64";
}

function archiveNameForVersion(version: string, format: AppFormat): string {
  switch (process.platform) {
    case "win32":
      return `mimiri_notes-${version}-full.nupkg`;
    case "linux":
      switch (format) {
        case "targz":
          return `mimiri-notes_${version}_${linuxArch()}.tar.gz`;
        case "appimage":
          return `mimiri-notes_${version}_${linuxArch()}.AppImage`;
        case "flatpak":
          return `${FLATPAK_APP_ID}_${version}_${linuxArch()}.flatpak`;
        case "snap":
          return `${SNAP_NAME}_${version}_${linuxArch()}.snap`;
        default:
          throw new Error(`unsupported format: ${format}`);
      }
    case "darwin":
      return `Mimiri Notes-darwin-universal-${version}.zip`;
    default:
      throw new Error(`unsupported platform: ${process.platform}`);
  }
}

/**
 * Directory a version+format is prepared in. Linux uses a per-format subdir
 * so fetching one format doesn't wipe a sibling; other platforms keep the
 * original `artifacts/<version>` layout.
 */
function targetDirFor(version: string, format: AppFormat): string {
  return process.platform === "linux"
    ? path.join(ARTIFACTS_DIR, version, format)
    : path.join(ARTIFACTS_DIR, version);
}

function executableRelPath(
  version: string,
  format: AppFormat,
): string | undefined {
  switch (process.platform) {
    case "win32":
      return path.join(
        "artifacts",
        version,
        "lib",
        "net45",
        "Mimiri Notes.exe",
      );
    case "linux":
      switch (format) {
        case "targz":
          return path.join(
            "artifacts",
            version,
            "targz",
            "mimiri-notes",
            "mimiri-notes",
          );
        case "appimage":
          return path.join(
            "artifacts",
            version,
            "appimage",
            archiveNameForVersion(version, format),
          );
        case "flatpak":
          return undefined; // installed into the user flatpak installation
        case "snap":
          return undefined; // installed system-wide by snapd
        default:
          throw new Error(`unsupported format: ${format}`);
      }
    case "darwin":
      return path.join(
        "artifacts",
        version,
        "Mimiri Notes.app",
        "Contents",
        "MacOS",
        "mimiri-notes",
      );
    default:
      throw new Error(`unsupported platform: ${process.platform}`);
  }
}

function parseVersion(fileName: string): string {
  const match = fileName.match(/(\d+\.\d+\.\d+)/);
  if (!match) {
    throw new Error(`could not parse version from file name: ${fileName}`);
  }
  return match[1];
}

function linuxFeedSuffix(format: AppFormat): string {
  switch (format) {
    case "targz":
      return `_${linuxArch()}.tar.gz`;
    case "appimage":
      return `_${linuxArch()}.AppImage`;
    case "flatpak":
      return `_${linuxArch()}.flatpak`;
    case "snap":
      return `_${linuxArch()}.snap`;
    default:
      throw new Error(`unsupported format: ${format}`);
  }
}

async function resolveFromFeed(
  channel: "stable" | "canary",
  format: AppFormat,
): Promise<{ url: string; version: string }> {
  const feedUrl = `${UPDATE_HOST}/latest.json`;
  console.log(`[fetch-artifact] resolving ${channel} from ${feedUrl}`);
  const res = await fetch(feedUrl);
  if (!res.ok) {
    throw new Error(`failed to fetch ${feedUrl}: HTTP ${res.status}`);
  }
  const feed = (await res.json()) as Feed;

  const systemName =
    process.platform === "win32"
      ? "Windows"
      : process.platform === "darwin"
        ? "MacOS"
        : "Linux";
  const system = feed.systems.find((s) => s.name === systemName);
  if (!system) {
    throw new Error(`no "${systemName}" entry in update feed`);
  }

  const links = system[channel] ?? system.links;
  const link =
    process.platform === "win32"
      ? links.find((l) => l.name.endsWith(".nupkg"))
      : process.platform === "darwin"
        ? links.find(
            (l) => l.name.includes("darwin") && l.name.endsWith(".zip"),
          )
        : links.find((l) => l.name.endsWith(linuxFeedSuffix(format)));
  if (!link) {
    throw new Error(
      `no matching ${channel} artifact for ${systemName}/${process.arch}${
        process.platform === "linux" ? `/${format}` : ""
      } in update feed`,
    );
  }
  return { url: link.url, version: parseVersion(link.name) };
}

async function download(url: string, destFile: string): Promise<void> {
  if (fs.existsSync(destFile)) {
    console.log(`[fetch-artifact] using cached ${path.basename(destFile)}`);
    return;
  }
  console.log(`[fetch-artifact] downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`failed to download ${url}: HTTP ${res.status}`);
  }
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  const partial = `${destFile}.partial`;
  await pipeline(
    Readable.fromWeb(res.body as import("stream/web").ReadableStream),
    fs.createWriteStream(partial),
  );
  fs.renameSync(partial, destFile);
  const size = fs.statSync(destFile).size;
  console.log(
    `[fetch-artifact] downloaded ${(size / 1024 / 1024).toFixed(1)} MB`,
  );
}

function extract(archive: string, targetDir: string): void {
  console.log(`[fetch-artifact] extracting to ${targetDir}`);
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
  if (process.platform === "darwin") {
    // ditto preserves .app bundle structure (symlinks, resource forks,
    // code signing metadata) more reliably than tar/unzip.
    const result = spawnSync("ditto", ["-xk", archive, targetDir], {
      stdio: "inherit",
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(`ditto exited with status ${result.status}`);
    }
    return;
  }
  // bsdtar (bundled with Windows 10+) transparently handles zip/nupkg;
  // GNU tar handles tar.gz on Linux. On Windows, use the system bsdtar
  // explicitly — a GNU tar earlier in PATH (e.g. from git-bash) can't read
  // zip archives. Use a path relative to the target dir so GNU tar doesn't
  // mistake a Windows drive letter for a remote host.
  const tarBin =
    process.platform === "win32"
      ? path.join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "tar.exe",
        )
      : "tar";
  const result = spawnSync(
    tarBin,
    ["-xf", path.relative(targetDir, archive), "-C", "."],
    { stdio: "inherit", cwd: targetDir },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`tar exited with status ${result.status}`);
  }
}

function runFlatpak(args: string[]): void {
  console.log(`[fetch-artifact] flatpak ${args.join(" ")}`);
  const result = spawnSync("flatpak", args, { stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`flatpak ${args[0]} exited with status ${result.status}`);
  }
}

/**
 * Ostree commit of the installed app, or undefined. Note: the *version*
 * flatpak info reports comes from the bundle's AppStream metainfo, whose
 * release history lags the actual app version, so the commit is the only
 * reliable way to tie an installation to a downloaded bundle. The app
 * version itself is asserted at test time via the user agent.
 */
function installedFlatpakCommit(): string | undefined {
  const result = spawnSync(
    "flatpak",
    ["info", "--user", "-c", FLATPAK_APP_ID],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    return undefined;
  }
  return result.stdout.trim() || undefined;
}

/** Installs the bundle and returns the installed ostree commit. */
function installFlatpak(bundle: string): string {
  // The bundle records flathub as its runtime repo; make sure the remote
  // exists so the runtime dependency can be resolved.
  runFlatpak([
    "remote-add",
    "--user",
    "--if-not-exists",
    "flathub",
    "https://dl.flathub.org/repo/flathub.flatpakrepo",
  ]);
  // Only one version of the app can be installed at a time, and installing
  // a bundle whose commit is already present fails even with --reinstall
  // (flatpak 1.14) — uninstall any existing copy first.
  spawnSync("flatpak", ["uninstall", "--user", "-y", FLATPAK_APP_ID], {
    stdio: "ignore",
  });
  runFlatpak(["install", "--user", "-y", bundle]);
  const commit = installedFlatpakCommit();
  if (!commit) {
    throw new Error(
      `flatpak install verification failed: ${FLATPAK_APP_ID} is not installed`,
    );
  }
  return commit;
}

/**
 * Version reported by snapd for the installed snap, or undefined. Unlike
 * flatpak's metainfo-derived version, this comes from snapcraft.yaml and
 * matches the app version.
 */
function installedSnapVersion(): string | undefined {
  const result = spawnSync("snap", ["list", SNAP_NAME], { encoding: "utf8" });
  if (result.status !== 0) {
    return undefined;
  }
  // Output: header line, then "Name  Version  Rev  ..."
  return result.stdout.split("\n")[1]?.split(/\s+/)[1];
}

function installSnap(bundle: string, version: string): void {
  // --dangerous: local file without store assertions. Auto-connectable
  // interfaces (home, x11, desktop, network, ...) still connect.
  console.log(`[fetch-artifact] sudo snap install --dangerous ${bundle}`);
  const result = spawnSync("sudo", ["snap", "install", "--dangerous", bundle], {
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`snap install exited with status ${result.status}`);
  }
  const installed = installedSnapVersion();
  if (installed !== version) {
    throw new Error(
      `snap install verification failed: expected version ${version}, ` +
        `snap list reports ${installed ?? "not installed"}`,
    );
  }
}

/**
 * Downloads the published bundle JSON for `version` into
 * `artifacts/<version>/bundle.json` (shared across Linux format subdirs —
 * the bundle is format-independent). The update e2e test serves this bundle,
 * version-bumped and re-signed with a test key, from a local mock server.
 * Verified against the production update key so a corrupt download fails
 * here rather than as a baffling in-app signature error at test time.
 *
 * Bundles are published per bundle version, which can lag the artifact
 * version (the shell version); on a 404 the channel pointer's version is
 * fetched instead — any real bundle works, the test rewrites its version.
 */
async function fetchBundleJson(
  version: string,
  channel: string,
): Promise<void> {
  const bundleFile = path.join(ARTIFACTS_DIR, version, "bundle.json");
  if (fs.existsSync(bundleFile)) {
    console.log(`[fetch-artifact] using existing bundle.json`);
    return;
  }
  let res = await fetch(`${UPDATE_HOST}/${UPDATE_KEY_NAME}.${version}.json`);
  if (res.status === 404) {
    const pointerChannel = channel === "canary" ? "canary" : "stable";
    const pointer = await fetch(
      `${UPDATE_HOST}/${UPDATE_KEY_NAME}.${pointerChannel}.json`,
    );
    if (!pointer.ok) {
      throw new Error(
        `failed to fetch ${pointerChannel} bundle pointer: HTTP ${pointer.status}`,
      );
    }
    const info = (await pointer.json()) as { version: string };
    console.log(
      `[fetch-artifact] no bundle for ${version}, falling back to ` +
        `${pointerChannel} bundle ${info.version}`,
    );
    res = await fetch(`${UPDATE_HOST}/${UPDATE_KEY_NAME}.${info.version}.json`);
  }
  if (!res.ok) {
    throw new Error(`failed to fetch bundle json: HTTP ${res.status}`);
  }
  const text = await res.text();
  const bundle = JSON.parse(text) as Bundle;
  if (
    !(await verifyBundleSignature(
      bundle,
      UPDATE_KEY_NAME,
      PRODUCTION_UPDATE_PUBLIC_KEY,
    ))
  ) {
    throw new Error(
      `bundle ${bundle.version} failed signature verification against the ` +
        `production update key`,
    );
  }
  fs.mkdirSync(path.dirname(bundleFile), { recursive: true });
  fs.writeFileSync(bundleFile, text);
  console.log(
    `[fetch-artifact] bundle.json ${bundle.version} downloaded and verified`,
  );
}

/** Whether the version+format is already fully prepared. */
function alreadyPrepared(
  metaFile: string,
  executable: string | undefined,
  format: AppFormat,
  version: string,
): boolean {
  if (!fs.existsSync(metaFile)) {
    return false;
  }
  if (format === "flatpak") {
    // The flatpak installation is global mutable state — meta.json alone
    // doesn't prove this bundle is still the one installed.
    const meta = JSON.parse(fs.readFileSync(metaFile, "utf8")) as ArtifactMeta;
    return (
      meta.flatpakCommit !== undefined &&
      meta.flatpakCommit === installedFlatpakCommit()
    );
  }
  if (format === "snap") {
    // Same reasoning: snapd holds the actual install.
    return installedSnapVersion() === version;
  }
  return executable !== undefined && fs.existsSync(executable);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const formatArg = args
    .find((a) => a.startsWith("--format="))
    ?.slice("--format=".length);
  const positional = args.filter((a) => !a.startsWith("--"));
  const arg = positional[0] ?? "stable";
  const format = resolveFormat(formatArg);

  let version: string;
  let url: string;
  let channel: string;
  if (arg === "stable" || arg === "canary") {
    channel = arg;
    ({ url, version } = await resolveFromFeed(arg, format));
  } else if (/^\d+\.\d+\.\d+$/.test(arg)) {
    channel = "explicit";
    version = arg;
    url = `${UPDATE_HOST}/${encodeURIComponent(archiveNameForVersion(version, format))}`;
  } else {
    throw new Error(
      `invalid argument "${arg}" — expected "stable", "canary" or a version like 2.6.1`,
    );
  }
  console.log(`[fetch-artifact] version ${version} (${channel}, ${format})`);

  const targetDir = targetDirFor(version, format);
  const metaFile = path.join(targetDir, "meta.json");
  const executable = executableRelPath(version, format);

  if (alreadyPrepared(metaFile, executable, format, version)) {
    console.log(
      `[fetch-artifact] ${version} (${format}) already prepared, skipping`,
    );
  } else {
    const archive = path.join(
      DOWNLOADS_DIR,
      archiveNameForVersion(version, format),
    );
    await download(url, archive);

    let flatpakCommit: string | undefined;
    if (format === "flatpak") {
      flatpakCommit = installFlatpak(archive);
      fs.rmSync(targetDir, { recursive: true, force: true });
      fs.mkdirSync(targetDir, { recursive: true });
    } else if (format === "snap") {
      installSnap(archive, version);
      fs.rmSync(targetDir, { recursive: true, force: true });
      fs.mkdirSync(targetDir, { recursive: true });
    } else if (format === "appimage") {
      fs.rmSync(targetDir, { recursive: true, force: true });
      fs.mkdirSync(targetDir, { recursive: true });
      fs.copyFileSync(archive, executable!);
      fs.chmodSync(executable!, 0o755);
    } else {
      extract(archive, targetDir);
    }

    if (executable !== undefined && !fs.existsSync(executable)) {
      throw new Error(
        `expected executable not found after extraction: ${executable}`,
      );
    }
    const meta: ArtifactMeta = {
      version,
      channel,
      platform: process.platform,
      format,
      ...(executable !== undefined ? { executablePath: executable } : {}),
      ...(format === "flatpak"
        ? { flatpakAppId: FLATPAK_APP_ID, flatpakCommit }
        : {}),
      ...(format === "snap" ? { snapName: SNAP_NAME } : {}),
    };
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  }

  // Runs even for already-prepared artifacts — they may have been fetched
  // before bundle.json existed.
  await fetchBundleJson(version, channel);

  if (process.platform === "win32") {
    // The Squirrel Setup.exe performs a real install (%LOCALAPPDATA%),
    // which the shell-update e2e test needs — the in-app updater only
    // works from a Squirrel-installed layout (Update.exe next to app-*).
    const setupName = `Mimiri Notes-${version} Setup.exe`;
    await download(
      `${UPDATE_HOST}/${encodeURIComponent(setupName)}`,
      path.join(DOWNLOADS_DIR, setupName),
    );
  }

  fs.writeFileSync(
    path.join(ARTIFACTS_DIR, "current.json"),
    JSON.stringify({ version, format }, null, 2),
  );
  console.log(
    `[fetch-artifact] done — current version is ${version} (${format})`,
  );
}

main().catch((err) => {
  console.error(`[fetch-artifact] failed:`, err);
  process.exitCode = 1;
});
