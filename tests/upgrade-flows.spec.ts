import { test, expect, Page } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";
import {
  AppContext,
  cleanup,
  getTestInfo,
  launchApp,
  supportsUpdateSeams,
} from "../helpers/app";
import { resolveFormat } from "../helpers/format";
import { enterLocalMode, openCheckForUpdates } from "../helpers/ui";
import {
  PassthroughShellPackage,
  PassthroughUpdateServer,
  startPassthroughUpdateServer,
} from "../helpers/update-server";
import {
  ProfileLayout,
  preSeedPreSeamProfile,
  profileDataDir,
  seedUserState,
  verifyUserState,
} from "../helpers/user-state";
import {
  ResolvedVersions,
  Scenario,
  Step,
  bundleAboveBase,
  homeLayoutAvailable,
  needsHomeLayout,
  resolveSelector,
  resolveVersions,
  runFetchArtifact,
  scenarioAppliesTo,
  scenarioVersions,
  scenarios,
} from "../helpers/upgrade-flows";
import {
  installShell,
  shellArchivePath,
  upgradeShell,
} from "../helpers/shell-upgrade";
import {
  APP_EXE_NAME,
  killAppInstances,
  runningAppPaths,
  squirrelRoot,
  uninstallSquirrelApp,
  waitForCondition,
  winShellArtifacts,
} from "../helpers/win-squirrel";
import {
  MAC_APP_BUNDLE,
  cleanShipItCache,
  killProcessesUnder,
  macAppBundleId,
  macAppVersion,
  processRunningUnder,
} from "../helpers/mac-squirrel";

/**
 * Upgrade-flow validation: proves that a specific newly published version
 * does not break EXISTING users. Each scenario (helpers/upgrade-flows.ts)
 * is a chain of steps between REAL published releases — install an old
 * version, seed user state through the UI, then bundle- and/or
 * shell-update towards the target, verifying notes, content, settings and
 * editability after every hop. All served update payloads keep their
 * production signatures (passthrough server); only MIMIRI_UPDATE_URL is
 * overridden, never the signing key.
 *
 * Opt-in: runs only with UPGRADE_FLOWS=1 (the upgrade-validation CI
 * workflow, or a manual run). Concrete versions come from
 * MIMIRI_TARGET_VERSION / MIMIRI_PREVIOUS_VERSION / MIMIRI_TARGET_BUNDLE
 * env with state/versions.json filling the rest; MIMIRI_SCENARIO
 * (comma-separated ids) narrows the scenario table.
 */

const UPGRADE_BUNDLES_DIR = path.resolve("artifacts", "bundles");

const scenarioFilter = process.env.MIMIRI_SCENARIO?.split(",");

interface RunState {
  ctx?: AppContext;
  server?: PassthroughUpdateServer;
  layout: ProfileLayout;
  /** Where the shell is installed (targz extract / mac .app). */
  workDir: string;
  /** Shell version currently installed/running. */
  shell: string;
  /** Bundle version the last update-bundle step activated. */
  bundle?: string;
  /** ShipIt cache owner, when a mac squirrel update ran. */
  macBundleId?: string;
  /** A Squirrel install owns machine-global state to uninstall. */
  squirrelInstalled: boolean;
  verifyCount: number;
}

function bundleJsonPath(version: string): string {
  return path.join(UPGRADE_BUNDLES_DIR, `${version}.json`);
}

function launchEnv(
  state: RunState,
  shellVersion: string,
): Record<string, string> {
  // The URL seam is only read by shells >= 2.6.9; older ones are steered
  // away from the production host via the pre-seeded profile instead.
  return state.server && supportsUpdateSeams(shellVersion)
    ? { MIMIRI_UPDATE_URL: state.server.url }
    : {};
}

async function launchInstalled(
  state: RunState,
  version: string,
  executablePath?: string,
): Promise<void> {
  state.ctx = await launchApp({
    version,
    userDataDir: state.layout.root,
    homeIsolation: state.layout.kind === "home",
    executablePath,
    env: launchEnv(state, version),
  });
  state.shell = version;
}

/**
 * (Re)installs a flatpak/snap version. fetch-artifact is idempotent and
 * commit/version-aware: with the download cached it is a quick reinstall,
 * needed because the installation is machine-global and a previous run's
 * mid-test upgrade leaves the TARGET installed, not the starting version.
 */
function installPackage(version: string, format: string): void {
  runFetchArtifact(version, format);
}

async function installStep(state: RunState, version: string): Promise<void> {
  if (!supportsUpdateSeams(version)) {
    preSeedPreSeamProfile(state.layout, version);
  }
  const format = resolveFormat();
  if (format === "flatpak" || format === "snap") {
    installPackage(version, format);
    state.ctx = await launchApp({
      version,
      format,
      userDataDir: state.layout.root,
      env: launchEnv(state, version),
    });
    state.shell = version;
    return;
  }
  const exe = await installShell(version, state.workDir);
  if (process.platform === "win32") {
    state.squirrelInstalled = true;
  }
  await launchInstalled(state, version, exe);
}

/** Settings → Updates: manual mode, arm the server, run a check. */
async function armAndCheck(
  state: RunState,
  version: string,
  opts?: { hostUpdate?: boolean },
): Promise<Page> {
  const page = state.ctx!.page;
  await openCheckForUpdates(state.ctx!);
  await expect(page.getByTestId("update-mode-select")).toBeVisible();
  // Manual mode BEFORE arming — the default auto-on-idle would let a
  // background check steal the flow.
  await page.getByTestId("update-mode-select").selectOption("manual-strong");
  state.server!.setLatest(version, opts);
  await page.getByTestId("update-check-button").click();
  await expect(page.getByTestId("update-available")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("update-new-version")).toHaveText(version);
  return page;
}

/** The version of the bundle the app is currently running. */
function activeBundleVersion(state: RunState): string | undefined {
  const configFile = path.join(
    profileDataDir(state.layout),
    "bundles",
    "config.json",
  );
  if (fs.existsSync(configFile)) {
    return (
      JSON.parse(fs.readFileSync(configFile, "utf8")) as {
        activeVersion?: string;
      }
    ).activeVersion;
  }
  return undefined;
}

async function updateBundleStep(state: RunState, to: string): Promise<void> {
  const info = await getTestInfo(state.ctx!.page);
  const active = activeBundleVersion(state) ?? info?.baseVersion;
  test.skip(
    !active || !supportsUpdateSeams(active),
    `active bundle ${active} cannot be pointed at the mock host (< 2.6.9)`,
  );
  if (info?.baseVersion && !bundleAboveBase(to, info.baseVersion)) {
    console.log(
      `[upgrade-flows] skipping bundle hop to ${to}: not above the ` +
        `shell's embedded base ${info.baseVersion}`,
    );
    return;
  }
  const page = await armAndCheck(state, to);
  await page.getByTestId("update-download-button").click();
  await expect(page.getByTestId("update-restart-button")).toBeVisible({
    timeout: 60_000,
  });
  // Pre-2.6.10 shells don't clear the HTTP cache on activation; a watchdog
  // reload mid-boot would revive the cached old bundle.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.clearBrowserCache");
  await cdp.detach();
  await page.getByTestId("update-restart-button").click({ noWaitAfter: true });
  await enterLocalMode(page);
  await openCheckForUpdates(state.ctx!);
  await expect(page.getByTestId("update-current-version")).toHaveText(to, {
    timeout: 15_000,
  });
  state.bundle = to;
}

async function externalShellStep(state: RunState, to: string): Promise<void> {
  await cleanup(state.ctx, { keepUserData: true });
  state.ctx = undefined;
  const exe = await upgradeShell(to, state.workDir);
  await launchInstalled(state, to, exe);
}

async function pkgmgrShellStep(state: RunState, to: string): Promise<void> {
  const format = resolveFormat();
  await cleanup(state.ctx, { keepUserData: true });
  state.ctx = undefined;
  installPackage(to, format);
  state.ctx = await launchApp({
    version: to,
    format,
    userDataDir: state.layout.root,
    env: launchEnv(state, to),
  });
  state.shell = to;
}

async function squirrelShellStep(state: RunState, to: string): Promise<void> {
  const page = await armAndCheck(state, to, { hostUpdate: true });
  await page.getByTestId("update-download-button").click();
  // Full installer over localhost + raw-signature verify.
  await expect(page.getByTestId("update-restart-button")).toBeVisible({
    timeout: 300_000,
  });
  // quitAndInstall hands off to Squirrel; the CDP connection dies with the
  // app, so the swap is asserted from the outside.
  await page.getByTestId("update-restart-button").click({ noWaitAfter: true });
  // Disarm before anything relaunches: an armed pointer offering the
  // version that is now the installed shell reads as a pending BUNDLE of
  // that version — a state no real host produces — and wedges the boot
  // in the update screen.
  state.server!.setLatest(null);

  if (process.platform === "win32") {
    const newAppDir = path.join(squirrelRoot(), `app-${to}`);
    await waitForCondition(
      `Squirrel to install ${newAppDir}`,
      () => fs.existsSync(newAppDir),
      180_000,
    );
    await waitForCondition(
      "the app to be relaunched from the new version",
      () => runningAppPaths().some((p) => p.includes(`app-${to}`)),
      120_000,
    );
    await cleanup(state.ctx, { keepUserData: true });
    state.ctx = undefined;
    // The Squirrel-relaunched instance runs against the DEFAULT profile
    // (no seams, no data-dir flag) — replace it with an attached launch
    // on the profile under test.
    killAppInstances();
    await launchInstalled(state, to, path.join(newAppDir, APP_EXE_NAME));
  } else {
    const appBundle = path.join(state.workDir, MAC_APP_BUNDLE);
    state.macBundleId = macAppBundleId(appBundle);
    await expect
      .poll(() => macAppVersion(appBundle), {
        message: `ShipIt to swap ${appBundle} to ${to}`,
        timeout: 300_000,
      })
      .toBe(to);
    await expect
      .poll(
        () => processRunningUnder(path.join(appBundle, "Contents", "MacOS")),
        {
          message: "the app to be relaunched from the updated bundle",
          timeout: 120_000,
        },
      )
      .toBe(true);
    await cleanup(state.ctx, { keepUserData: true });
    state.ctx = undefined;
    killProcessesUnder(state.workDir);
    await launchInstalled(
      state,
      to,
      path.join(appBundle, "Contents", "MacOS", "mimiri-notes"),
    );
  }
}

/** Pre-flight: every artifact a scenario will touch, with fix-it hints. */
function missingArtifacts(scenario: Scenario, rv: ResolvedVersions): string[] {
  const format = resolveFormat();
  const missing: string[] = [];
  const need = (file: string, what: string) => {
    if (!fs.existsSync(file)) {
      missing.push(`${what} (${file})`);
    }
  };
  for (const step of scenario.steps) {
    if (
      step.do === "install" ||
      (step.do === "update-shell" && step.via !== "pkgmgr")
    ) {
      const version = resolveSelector(
        step.do === "install" ? step.version : step.to,
        rv,
      )!;
      if (format === "flatpak" || format === "snap") {
        continue; // installed state is asserted by launchApp itself
      }
      need(shellArchivePath(version), `shell ${version}`);
      if (step.do === "update-shell" && step.via === "squirrel") {
        const osName = process.platform === "win32" ? "win" : "darwin";
        need(
          path.resolve(
            "artifacts",
            "downloads",
            `electron-${osName}.${version}.json`,
          ),
          `shell-update descriptor for ${version}`,
        );
        if (process.platform === "win32") {
          need(winShellArtifacts(version).nupkg, `nupkg ${version}`);
        }
      }
    } else if (step.do === "update-bundle") {
      const version = resolveSelector(step.to, rv)!;
      need(bundleJsonPath(version), `bundle ${version}`);
    }
  }
  return missing;
}

/** Servable payloads for the scenario's update steps. */
function serverConfig(
  scenario: Scenario,
  rv: ResolvedVersions,
):
  | {
      bundles: Map<string, string>;
      shellPackages: PassthroughShellPackage[];
    }
  | undefined {
  const bundles = new Map<string, string>();
  const shellPackages: PassthroughShellPackage[] = [];
  for (const step of scenario.steps) {
    if (step.do === "update-bundle") {
      const version = resolveSelector(step.to, rv)!;
      bundles.set(version, bundleJsonPath(version));
    } else if (step.do === "update-shell" && step.via === "squirrel") {
      const version = resolveSelector(step.to, rv)!;
      const osName = process.platform === "win32" ? "win" : "darwin";
      shellPackages.push({
        version,
        packagePath:
          process.platform === "win32"
            ? winShellArtifacts(version).nupkg
            : shellArchivePath(version),
        infoJsonPath: path.resolve(
          "artifacts",
          "downloads",
          `electron-${osName}.${version}.json`,
        ),
      });
    }
  }
  return bundles.size || shellPackages.length
    ? { bundles, shellPackages }
    : undefined;
}

test.describe("upgrade flows", () => {
  for (const scenario of scenarios) {
    test(scenario.id, async () => {
      test.setTimeout(900_000);
      test.skip(
        !process.env.UPGRADE_FLOWS,
        "upgrade-flow validation is opt-in — set UPGRADE_FLOWS=1",
      );
      test.skip(
        !!scenarioFilter && !scenarioFilter.includes(scenario.id),
        "not selected by MIMIRI_SCENARIO",
      );
      const format = resolveFormat();
      test.skip(
        !scenarioAppliesTo(scenario, process.platform, format),
        `runs on ${scenario.platforms?.join("/") ?? "all platforms"} ` +
          `(${scenario.formats?.join("/") ?? "all formats"})`,
      );
      const rv = resolveVersions();
      const versions = scenarioVersions(scenario, rv);
      test.skip(
        !versions,
        "a version selector is unresolvable — pass MIMIRI_TARGET_VERSION/" +
          "MIMIRI_PREVIOUS_VERSION or grow state/versions.json history",
      );

      // Simulate the shell chain: a hop to the version already installed
      // means there is nothing to validate (e.g. right after a promotion).
      let simulatedShell: string | undefined;
      for (const step of scenario.steps) {
        if (step.do === "install") {
          simulatedShell = resolveSelector(step.version, rv);
        } else if (step.do === "update-shell") {
          const to = resolveSelector(step.to, rv);
          test.skip(
            to === simulatedShell,
            `shell hop ${simulatedShell} -> ${to} is a no-op`,
          );
          simulatedShell = to;
        }
      }

      const needsHome = needsHomeLayout(versions!.shells);
      test.skip(
        needsHome && !homeLayoutAvailable(process.platform, format),
        "home-layout profile (pre-2.6.6 shell in the chain) is not " +
          "available on this platform/format",
      );

      const missing = missingArtifacts(scenario, rv);
      test.skip(
        missing.length > 0,
        `missing artifacts: ${missing.join(", ")} — run ` +
          `\`npm run prepare-upgrade -- --format=${format}\``,
      );

      const state: RunState = {
        layout: {
          kind: needsHome ? "home" : "flag",
          root: fs.mkdtempSync(
            format === "snap"
              ? path.join(os.homedir(), "mimiri-upg-")
              : path.join(os.tmpdir(), "mimiri-upg-"),
          ),
        },
        workDir: fs.mkdtempSync(path.join(os.tmpdir(), "mimiri-upg-shell-")),
        shell: "",
        squirrelInstalled: false,
        verifyCount: 0,
      };

      try {
        const config = serverConfig(scenario, rv);
        if (config) {
          state.server = await startPassthroughUpdateServer(config);
        }

        for (const step of scenario.steps) {
          await runStep(state, step, rv);
        }
      } finally {
        if (state.server && test.info().status !== test.info().expectedStatus) {
          console.log(
            `[upgrade-flows] update-server requests:\n  ` +
              state.server.requests.join("\n  "),
          );
        }
        await cleanup(state.ctx);
        if (state.squirrelInstalled) {
          uninstallSquirrelApp();
        }
        if (process.platform === "darwin") {
          killProcessesUnder(state.workDir);
          cleanShipItCache(state.macBundleId);
        }
        fs.rmSync(state.workDir, { recursive: true, force: true });
        fs.rmSync(state.layout.root, { recursive: true, force: true });
        await state.server?.stop();
      }
    });
  }
});

async function runStep(
  state: RunState,
  step: Step,
  rv: ResolvedVersions,
): Promise<void> {
  switch (step.do) {
    case "install": {
      const version = resolveSelector(step.version, rv)!;
      await test.step(`install ${version}`, () => installStep(state, version));
      break;
    }
    case "seed-state": {
      await test.step("seed user state", () =>
        seedUserState(state.ctx!, state.layout));
      break;
    }
    case "update-bundle": {
      const version = resolveSelector(step.to, rv)!;
      await test.step(`bundle update to ${version}`, () =>
        updateBundleStep(state, version));
      break;
    }
    case "update-shell": {
      const version = resolveSelector(step.to, rv)!;
      await test.step(`shell update to ${version} (${step.via})`, () =>
        step.via === "external"
          ? externalShellStep(state, version)
          : step.via === "pkgmgr"
            ? pkgmgrShellStep(state, version)
            : squirrelShellStep(state, version));
      break;
    }
    case "verify": {
      state.verifyCount += 1;
      const count = state.verifyCount;
      await test.step(`verify on ${state.shell}`, () =>
        verifyUserState(state.ctx!, state.layout, {
          shellVersion: state.shell,
          bundleVersion: state.bundle,
          step: String(count),
        }));
      break;
    }
  }
}
