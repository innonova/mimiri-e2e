import { chromium, Browser, Page } from "playwright";
import { spawn, spawnSync, ChildProcess } from "child_process";
import path from "path";
import os from "os";
import fs from "fs";

export interface ArtifactMeta {
  version: string;
  channel: string;
  platform: NodeJS.Platform;
  /** Path of the app executable, relative to the repo root. */
  executablePath: string;
}

export interface AppContext {
  browser: Browser;
  page: Page;
  process: ChildProcess;
  userDataDir: string;
  version: string;
  /** Channel the artifact was fetched from: stable | canary | explicit. */
  channel: string;
}

/** Injected by the app (2.6.5+) when launched with APP_TEST_MODE=1. */
export interface MimiriTestInfo {
  version: string;
  baseVersion: string;
  /**
   * Channel of the embedded bundle — always "stable", even in canary builds,
   * because canary clients are created from the stable-bound bundle before
   * promotion. Do not compare against the download feed channel.
   */
  channel: string;
  platform: string;
}

/**
 * Reads the test-mode seam injected by the app. Returns undefined for
 * versions that predate it (< 2.6.5).
 */
export async function getTestInfo(
  page: Page,
): Promise<MimiriTestInfo | undefined> {
  return page.evaluate(
    () =>
      (globalThis as unknown as { mimiriTestInfo?: MimiriTestInfo })
        .mimiriTestInfo,
  );
}

/** Resolves the version under test: explicit > MIMIRI_VERSION env > current.json. */
function resolveVersion(version?: string): string {
  if (version) {
    return version;
  }
  if (process.env.MIMIRI_VERSION) {
    return process.env.MIMIRI_VERSION;
  }
  const currentFile = path.resolve("artifacts", "current.json");
  if (!fs.existsSync(currentFile)) {
    throw new Error(
      "no artifact prepared — run `npm run fetch` first (or set MIMIRI_VERSION)",
    );
  }
  return (
    JSON.parse(fs.readFileSync(currentFile, "utf8")) as { version: string }
  ).version;
}

export function loadMeta(version?: string): ArtifactMeta {
  const resolved = resolveVersion(version);
  const metaFile = path.resolve("artifacts", resolved, "meta.json");
  if (!fs.existsSync(metaFile)) {
    throw new Error(
      `no artifact for version ${resolved} — run \`npm run fetch -- ${resolved}\` first`,
    );
  }
  return JSON.parse(fs.readFileSync(metaFile, "utf8")) as ArtifactMeta;
}

/** Native --user-data-dir support landed in the client in 2.6.6. */
function supportsUserDataDirFlag(version: string): boolean {
  const [maj, min, pat] = version.split(".").map(Number);
  return maj > 2 || (maj === 2 && (min > 6 || (min === 6 && pat >= 6)));
}

/**
 * Launches the packaged app and attaches over CDP.
 *
 * Note: published Mimiri builds have the Node `--inspect` CLI flags fused
 * off, so Playwright's `_electron.launch()` cannot attach. Instead we spawn
 * the executable with `--remote-debugging-port=0` (which still works) and
 * connect to the Chromium side of the app.
 */
export async function launchApp(
  opts: { version?: string; userDataDir?: string } = {},
): Promise<AppContext> {
  const meta = loadMeta(opts.version);
  const executablePath = path.resolve(meta.executablePath);
  const userDataDir =
    opts.userDataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "mimiri-e2e-")); // fresh by default

  // The app honors `--user-data-dir` natively since 2.6.6 (applied via
  // app.setPath in main.ts). For older builds, fall back to redirecting
  // the location Electron resolves `userData` from: APPDATA (Windows),
  // XDG_CONFIG_HOME (Linux), HOME (macOS, via ~/Library).
  const isolationEnv: Record<string, string> = supportsUserDataDirFlag(
    meta.version,
  )
    ? {}
    : process.platform === "win32"
      ? { APPDATA: userDataDir }
      : process.platform === "darwin"
        ? { HOME: userDataDir }
        : { XDG_CONFIG_HOME: userDataDir };

  const child = spawn(
    executablePath,
    ["--remote-debugging-port=0", `--user-data-dir=${userDataDir}`],
    {
      env: { ...process.env, ...isolationEnv, APP_TEST_MODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  try {
    const wsEndpoint = await waitForDevToolsEndpoint(child);
    const browser = await chromium.connectOverCDP(wsEndpoint);
    const page = await waitForFirstPage(browser);
    return {
      browser,
      page,
      process: child,
      userDataDir,
      version: meta.version,
      channel: meta.channel,
    };
  } catch (err) {
    killAppProcess(child);
    throw err;
  }
}

/** Waits for the "DevTools listening on ws://..." line on stderr/stdout. */
function waitForDevToolsEndpoint(
  child: ChildProcess,
  timeoutMs = 30_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      reject(
        new Error(
          `timed out waiting for DevTools endpoint; app output so far:\n${output}`,
        ),
      );
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    child.stderr?.on("data", onData);
    child.stdout?.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`app exited with code ${code} before CDP was ready`));
    });
  });
}

/** Waits for the app's first window (page) to appear. */
async function waitForFirstPage(
  browser: Browser,
  timeoutMs = 30_000,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = browser.contexts().flatMap((c) => c.pages())[0];
    if (page) {
      return page;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timed out waiting for the app's first window");
}

function killAppProcess(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) {
    return;
  }
  if (process.platform === "win32") {
    // Kill the whole process tree; the app keeps running in the tray and
    // renderer processes would otherwise be orphaned.
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
  } else {
    child.kill("SIGKILL");
  }
}

/** Closes the app and removes its temp user data dir. */
export async function cleanup(ctx: AppContext | undefined): Promise<void> {
  if (!ctx) {
    return;
  }
  try {
    await ctx.browser.close();
  } catch {
    // already disconnected — still kill the process and remove the data dir
  }
  const exited = new Promise<void>((resolve) => {
    if (ctx.process.exitCode !== null) {
      resolve();
    } else {
      ctx.process.on("exit", () => resolve());
      setTimeout(resolve, 5_000).unref();
    }
  });
  killAppProcess(ctx.process);
  await exited;
  fs.rmSync(ctx.userDataDir, {
    recursive: true,
    force: true,
    maxRetries: 10, // Windows can hold file locks briefly after exit
    retryDelay: 200,
  });
}
