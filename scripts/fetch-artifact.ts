/**
 * Fetches the packaged Mimiri Notes Electron app and prepares it under
 * `artifacts/<version>` so the e2e suite has something to launch.
 *
 * Usage:
 *   npm run fetch                  # latest stable
 *   npm run fetch -- canary        # latest canary
 *   npm run fetch -- 2.6.1         # explicit version
 *
 * Supported platforms: Windows (.nupkg) and Linux (.tar.gz).
 */
import path from "path";
import fs from "fs";
import { spawnSync } from "child_process";
import { pipeline } from "stream/promises";
import { Readable } from "stream";

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

export interface ArtifactMeta {
  version: string;
  channel: string;
  platform: NodeJS.Platform;
  /** Path of the app executable, relative to the repo root. */
  executablePath: string;
}

function linuxArch(): string {
  return process.arch === "arm64" ? "arm64" : "amd64";
}

function archiveNameForVersion(version: string): string {
  switch (process.platform) {
    case "win32":
      return `mimiri_notes-${version}-full.nupkg`;
    case "linux":
      return `mimiri-notes_${version}_${linuxArch()}.tar.gz`;
    case "darwin":
      return `Mimiri Notes-darwin-universal-${version}.zip`;
    default:
      throw new Error(`unsupported platform: ${process.platform}`);
  }
}

function executableRelPath(version: string): string {
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
      return path.join("artifacts", version, "mimiri-notes", "mimiri-notes");
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

async function resolveFromFeed(
  channel: "stable" | "canary",
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
        ? links.find((l) => l.name.includes("darwin") && l.name.endsWith(".zip"))
        : links.find((l) => l.name.endsWith(`_${linuxArch()}.tar.gz`));
  if (!link) {
    throw new Error(
      `no matching ${channel} artifact for ${systemName}/${process.arch} in update feed`,
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

async function main(): Promise<void> {
  const arg = process.argv[2] ?? "stable";

  let version: string;
  let url: string;
  let channel: string;
  if (arg === "stable" || arg === "canary") {
    channel = arg;
    ({ url, version } = await resolveFromFeed(arg));
  } else if (/^\d+\.\d+\.\d+$/.test(arg)) {
    channel = "explicit";
    version = arg;
    url = `${UPDATE_HOST}/${encodeURIComponent(archiveNameForVersion(version))}`;
  } else {
    throw new Error(
      `invalid argument "${arg}" — expected "stable", "canary" or a version like 2.6.1`,
    );
  }
  console.log(`[fetch-artifact] version ${version} (${channel})`);

  const targetDir = path.join(ARTIFACTS_DIR, version);
  const metaFile = path.join(targetDir, "meta.json");
  const executable = executableRelPath(version);

  if (fs.existsSync(metaFile) && fs.existsSync(executable)) {
    console.log(`[fetch-artifact] ${version} already prepared, skipping`);
  } else {
    const archive = path.join(DOWNLOADS_DIR, archiveNameForVersion(version));
    await download(url, archive);
    extract(archive, targetDir);

    if (!fs.existsSync(executable)) {
      throw new Error(
        `expected executable not found after extraction: ${executable}`,
      );
    }
    const meta: ArtifactMeta = {
      version,
      channel,
      platform: process.platform,
      executablePath: executable,
    };
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  }

  fs.writeFileSync(
    path.join(ARTIFACTS_DIR, "current.json"),
    JSON.stringify({ version }, null, 2),
  );
  console.log(`[fetch-artifact] done — current version is ${version}`);
}

main().catch((err) => {
  console.error(`[fetch-artifact] failed:`, err);
  process.exitCode = 1;
});
