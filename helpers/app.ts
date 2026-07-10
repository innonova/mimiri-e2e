import { chromium, Browser, Page } from "playwright";
import { spawn, spawnSync, ChildProcess } from "child_process";
import path from "path";
import os from "os";
import fs from "fs";
import {
  AppFormat,
  ArtifactMeta,
  FLATPAK_APP_ID,
  SNAP_NAME,
  resolveFormat,
} from "./format";

export type { ArtifactMeta } from "./format";

export interface AppContext {
  browser: Browser;
  page: Page;
  process: ChildProcess;
  userDataDir: string;
  version: string;
  /** Channel the artifact was fetched from: stable | canary | explicit. */
  channel: string;
  /** Package format under test: targz | flatpak | appimage | snap. */
  format: AppFormat;
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

/**
 * Resolves the artifact under test: explicit > MIMIRI_VERSION / APP_FORMAT
 * env > current.json.
 */
function resolveTarget(opts: { version?: string; format?: string }): {
  version: string;
  format: AppFormat;
} {
  let version = opts.version || process.env.MIMIRI_VERSION;
  let format: AppFormat | undefined =
    opts.format || process.env.APP_FORMAT
      ? resolveFormat(opts.format)
      : undefined;
  if (!version || !format) {
    const currentFile = path.resolve("artifacts", "current.json");
    if (!fs.existsSync(currentFile)) {
      if (!version) {
        throw new Error(
          "no artifact prepared — run `npm run fetch` first (or set MIMIRI_VERSION)",
        );
      }
    } else {
      const current = JSON.parse(fs.readFileSync(currentFile, "utf8")) as {
        version: string;
        format?: string;
      };
      version ??= current.version;
      format ??= resolveFormat(current.format);
    }
  }
  return { version: version!, format: format ?? resolveFormat() };
}

export function loadMeta(version?: string, format?: string): ArtifactMeta {
  const target = resolveTarget({ version, format });
  // Linux artifacts live in a per-format subdir; other platforms (and Linux
  // targz artifacts fetched before formats existed) use artifacts/<version>.
  const candidates =
    process.platform === "linux"
      ? target.format === "targz"
        ? [
            path.resolve("artifacts", target.version, "targz", "meta.json"),
            path.resolve("artifacts", target.version, "meta.json"), // legacy
          ]
        : [
            path.resolve(
              "artifacts",
              target.version,
              target.format,
              "meta.json",
            ),
          ]
      : [path.resolve("artifacts", target.version, "meta.json")];
  const metaFile = candidates.find((f) => fs.existsSync(f));
  if (!metaFile) {
    throw new Error(
      `no ${target.format} artifact for version ${target.version} — run ` +
        `\`npm run fetch -- ${target.version} --format=${target.format}\` first`,
    );
  }
  const meta = JSON.parse(fs.readFileSync(metaFile, "utf8")) as ArtifactMeta;
  meta.format ??= "targz";
  return meta;
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
  opts: {
    version?: string;
    /** Package format to launch: targz | flatpak | appimage. */
    format?: string;
    userDataDir?: string;
    /**
     * Extra environment for the app process (e.g. GTK_USE_PORTAL). An
     * empty-string value removes the variable from the app's environment.
     */
    env?: Record<string, string>;
  } = {},
): Promise<AppContext> {
  const meta = loadMeta(opts.version, opts.format);
  const format = meta.format ?? "targz";
  // Fresh temp dir by default. Strict snap confinement has a private /tmp
  // and the home interface excludes dotfiles, so for snap the dir must be a
  // non-hidden path under $HOME.
  const userDataDir =
    opts.userDataDir ??
    fs.mkdtempSync(
      format === "snap"
        ? path.join(os.homedir(), "mimiri-e2e-")
        : path.join(os.tmpdir(), "mimiri-e2e-"),
    );

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

  const appArgs = [
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
  ];
  // An empty-string value in opts.env means "make sure this variable is NOT
  // set for the app", even if the surrounding environment exports it (e.g.
  // GTK_USE_PORTAL=1 from run-with-dialogs.sh).
  const appEnv: Record<string, string> = {
    ...isolationEnv,
    ...opts.env,
    APP_TEST_MODE: "1",
  };
  const unsetKeys = Object.keys(appEnv).filter((k) => appEnv[k] === "");
  for (const k of unsetKeys) {
    delete appEnv[k];
  }
  const mergedEnv = { ...process.env, ...appEnv };
  for (const k of unsetKeys) {
    delete mergedEnv[k];
  }

  let child: ChildProcess;
  if (format === "flatpak") {
    assertFlatpakInstallMatches(meta);
    // `flatpak run` filters the caller's environment, so the app's env must
    // travel as --env= flags (unset keys simply aren't forwarded). The temp
    // user-data dir is outside the sandbox (the manifest grants no
    // filesystem access) and needs a per-run --filesystem override. The
    // bwrap client still gets process.env so it can reach DISPLAY and the
    // session bus.
    child = spawn(
      "flatpak",
      [
        "run",
        ...Object.entries(appEnv).map(([k, v]) => `--env=${k}=${v}`),
        `--filesystem=${userDataDir}`,
        meta.flatpakAppId ?? FLATPAK_APP_ID,
        ...appArgs,
      ],
      {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } else if (format === "snap") {
    // `snap run` passes the caller's environment through to the confined
    // app, so a plain env merge works (unlike flatpak).
    child = spawn("snap", ["run", meta.snapName ?? SNAP_NAME, ...appArgs], {
      env: mergedEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } else {
    if (!meta.executablePath) {
      throw new Error(
        `artifact meta for ${meta.version} (${format}) has no executablePath`,
      );
    }
    child = spawn(path.resolve(meta.executablePath), appArgs, {
      env: mergedEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

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
      format,
    };
  } catch (err) {
    killAppProcess(child, format);
    throw err;
  }
}

/**
 * The flatpak installation is global mutable state (only one version can be
 * installed at a time); make sure it is still the one this meta was written
 * for before launching. Compares ostree commits — the version flatpak
 * reports comes from the bundle's AppStream metainfo, which lags the app.
 */
function assertFlatpakInstallMatches(meta: ArtifactMeta): void {
  const appId = meta.flatpakAppId ?? FLATPAK_APP_ID;
  const result = spawnSync("flatpak", ["info", "--user", "-c", appId], {
    encoding: "utf8",
  });
  const installed = result.status === 0 ? result.stdout.trim() : undefined;
  if (!installed || installed !== meta.flatpakCommit) {
    throw new Error(
      `installed flatpak ${appId} (commit ${installed ?? "none"}) does not ` +
        `match the fetched artifact for ${meta.version} — run ` +
        `\`npm run fetch -- ${meta.version} --format=flatpak\` first`,
    );
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
      // The process may exit right after the exec fails, before its final
      // stderr chunk is flushed to our handlers — give it a beat so the
      // error includes what the app actually printed.
      setTimeout(() => {
        reject(
          new Error(
            `app exited with code ${code} before CDP was ready; app output:\n${output}`,
          ),
        );
      }, 200);
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

function killAppProcess(child: ChildProcess, format: AppFormat): void {
  if (child.exitCode !== null || child.pid === undefined) {
    return;
  }
  if (format === "flatpak") {
    // SIGKILL on the `flatpak run` client would orphan the sandboxed app;
    // ask flatpak to tear down the sandbox, then reap the client.
    spawnSync("flatpak", ["kill", FLATPAK_APP_ID]);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
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
  killAppProcess(ctx.process, ctx.format);
  await exited;
  fs.rmSync(ctx.userDataDir, {
    recursive: true,
    force: true,
    maxRetries: 10, // Windows can hold file locks briefly after exit
    retryDelay: 200,
  });
}
