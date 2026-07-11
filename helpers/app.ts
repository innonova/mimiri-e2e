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

/**
 * The release shell-upgrade tests start from: the first with the
 * MIMIRI_UPDATE_URL/MIMIRI_UPDATE_KEY seams. Kept downloadable forever on
 * the update host, so the tests work regardless of the current version.
 */
export const SHELL_UPGRADE_BASE_VERSION = "2.6.9";

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
  /** Echo of MIMIRI_UPDATE_URL (update-host override, 2.6.9+ seams). */
  updateUrl?: string;
  /** Echo of MIMIRI_UPDATE_KEY (test signing key override, 2.6.9+ seams). */
  updateKey?: string;
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

/** Whether `version` is at least maj.min.pat. */
export function versionAtLeast(
  version: string,
  maj: number,
  min: number,
  pat: number,
): boolean {
  const [vMaj, vMin, vPat] = version.split(".").map(Number);
  return (
    vMaj > maj ||
    (vMaj === maj && (vMin > min || (vMin === min && vPat >= pat)))
  );
}

/** Native --user-data-dir support landed in the client in 2.6.6. */
export function supportsUserDataDirFlag(version: string): boolean {
  return versionAtLeast(version, 2, 6, 6);
}

/**
 * The MIMIRI_UPDATE_URL / MIMIRI_UPDATE_KEY seams (update-host and signing
 * key overrides for update testing) landed in the client in 2.6.9.
 */
export function supportsUpdateSeams(version: string): boolean {
  return versionAtLeast(version, 2, 6, 9);
}

/**
 * Hardened bundle handling (verified promotion, health-checked activation,
 * broken bundles fall back to base and self-repair) landed in the shell in
 * 2.6.11 — but on slow machines its post-activation boot could still be
 * interrupted by a watch dog navigation and wedge (seen on mac/win/snap
 * CI); 2.6.12 adds the activation grace period that makes it reliable.
 */
export function supportsBundleRepair(version: string): boolean {
  return versionAtLeast(version, 2, 6, 12);
}

/**
 * Flathub/snap-store detection (and the MIMIRI_FAKE_STORE test seam)
 * landed in the shell in 2.6.13; the store-managed update UI needs a
 * bundle >= 2.6.7 (testids + the store-managed check() branch).
 */
export function supportsStoreDetection(version: string): boolean {
  return versionAtLeast(version, 2, 6, 13);
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
    /**
     * Launch this executable instead of the artifact's extracted one —
     * e.g. a Squirrel-installed copy for shell-update tests. targz-style
     * formats only.
     */
    executablePath?: string;
    /**
     * Isolate via a fake HOME instead of --user-data-dir: userDataDir acts
     * as the home directory and no flag is passed, so data lands where a
     * real install puts it — settings/bundles in ~/.mimiri, the Chromium
     * profile (where the client keeps its IndexedDB note stores) under
     * ~/.config (Linux) / ~/Library (macOS) / %APPDATA% (Windows, via a
     * USERPROFILE+APPDATA redirect). Required when a profile must carry
     * across shells on both sides of 2.6.6: the --user-data-dir layout
     * and the home-derived layout are different directory shapes, and
     * only the home-derived one exists on real user machines. targz-style
     * formats only (flatpak/snap confinement has its own layout).
     */
    homeIsolation?: boolean;
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
  // XDG_CONFIG_HOME (Linux), HOME (macOS, via ~/Library). With
  // homeIsolation, redirect HOME (and the XDG dirs Electron would
  // otherwise take from the real environment) instead, for every version.
  let isolationEnv: Record<string, string>;
  if (opts.homeIsolation) {
    if (process.platform === "darwin") {
      isolationEnv = { HOME: userDataDir };
    } else if (process.platform === "win32") {
      // Windows has NO working env-based home isolation: Electron
      // resolves home (→ ~/.mimiri) and appData through Windows APIs
      // that ignore USERPROFILE/APPDATA overrides, splitting state
      // between the fake and the real profile (and an APPDATA override
      // exits the app code 1; a fake USERPROFILE without AppData\Roaming
      // hard-crashes it 0x80000003 — both without any output). Callers
      // must pass the REAL home as userDataDir (real-profile mode, see
      // tests/upgrade-flows.spec.ts) — this branch then only drops the
      // --user-data-dir flag so the app uses its natural profile paths.
      if (path.resolve(userDataDir) !== path.resolve(os.homedir())) {
        throw new Error(
          "homeIsolation on Windows only works against the real profile — " +
            "pass userDataDir: os.homedir() (and wipe the app state " +
            "around the run)",
        );
      }
      isolationEnv = {};
    } else {
      isolationEnv = {
        HOME: userDataDir,
        XDG_CONFIG_HOME: path.join(userDataDir, ".config"),
        XDG_DATA_HOME: path.join(userDataDir, ".local", "share"),
      };
    }
  } else {
    isolationEnv = supportsUserDataDirFlag(meta.version)
      ? {}
      : process.platform === "win32"
        ? { APPDATA: userDataDir }
        : process.platform === "darwin"
          ? { HOME: userDataDir }
          : { XDG_CONFIG_HOME: userDataDir };
  }

  const appArgs = [
    "--remote-debugging-port=0",
    ...(opts.homeIsolation ? [] : [`--user-data-dir=${userDataDir}`]),
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
    const executablePath = opts.executablePath ?? meta.executablePath;
    if (!executablePath) {
      throw new Error(
        `artifact meta for ${meta.version} (${format}) has no executablePath`,
      );
    }
    child = spawn(path.resolve(executablePath), appArgs, {
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

/**
 * Closes the app and removes its temp user data dir. Pass
 * `keepUserData: true` for multi-launch flows (e.g. shell-upgrade tests)
 * that relaunch against the same profile.
 */
export async function cleanup(
  ctx: AppContext | undefined,
  opts: { keepUserData?: boolean } = {},
): Promise<void> {
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
  if (!opts.keepUserData) {
    fs.rmSync(ctx.userDataDir, {
      recursive: true,
      force: true,
      maxRetries: 10, // Windows can hold file locks briefly after exit
      retryDelay: 200,
    });
  }
}
