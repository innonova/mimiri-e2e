import fs from "fs";
import path from "path";
import { versionAtLeast } from "./app";
import { AppFormat } from "./format";

/**
 * Scenario model for the upgrade-flow validation suite
 * (tests/upgrade-flows.spec.ts): multi-step chains between REAL published
 * versions — install an old release, seed user state, then bundle- and/or
 * shell-update towards the version under validation, verifying the state
 * after every hop.
 *
 * Scenarios never name concrete versions; they use selectors resolved at
 * run time from env inputs (what the trigger passes) falling back to the
 * committed watcher state (state/versions.json). A new publish therefore
 * requires no edits here.
 */

/** Oldest release the external-reinstall flows start from. Pre-seam
 * (< 2.6.9: MIMIRI_UPDATE_URL is inert, the client talks to the real
 * update host) and pre user-data-dir flag (< 2.6.6), so it is only used
 * for flows that need no update-host control. */
export const ANCIENT_BASE_VERSION = "2.6.1";

export type VersionSelector =
  /** The version under validation (the newly published one). */
  | { kind: "target" }
  /** The version the channel pointed at before target — what most
   * existing users are on. */
  | { kind: "previous" }
  /** The current stable shell — users on the slow channel. */
  | { kind: "stable" }
  /** ANCIENT_BASE_VERSION. */
  | { kind: "ancient" }
  /** The newest published bundle for the channel. */
  | { kind: "bundle-latest" }
  /** The bundle the channel pointed at before bundle-latest. */
  | { kind: "bundle-previous" }
  | { kind: "pin"; version: string };

export type Step =
  | { do: "install"; version: VersionSelector }
  | { do: "seed-state" }
  /** In-app bundle update via the Settings → Updates UI (needs a shell and
   * an active bundle >= 2.6.9). */
  | { do: "update-bundle"; to: VersionSelector }
  | {
      do: "update-shell";
      to: VersionSelector;
      /**
       * squirrel — the in-app shell updater (win32/darwin);
       * external — quit, install-over (extract / Setup.exe), relaunch;
       * pkgmgr — flatpak/snap install of the newer package.
       */
      via: "squirrel" | "external" | "pkgmgr";
    }
  | { do: "verify" };

export interface Scenario {
  /** Stable id, used with MIMIRI_SCENARIO to filter runs. */
  id: string;
  title: string;
  /** Platforms the scenario runs on; undefined = all. */
  platforms?: NodeJS.Platform[];
  /** Package formats the scenario runs under; undefined = all. */
  formats?: AppFormat[];
  steps: Step[];
}

/**
 * Which from→to pairs and mechanisms a validation run covers. Every entry
 * self-skips when its selectors resolve to nothing useful (see
 * resolveSelector / the runner's skip rules), so the table can be broader
 * than any single run.
 */
export const scenarios: Scenario[] = [
  {
    id: "previous-to-target-external",
    title: "previous release, seeded, reinstall-over to target",
    formats: ["targz"],
    steps: [
      { do: "install", version: { kind: "previous" } },
      { do: "seed-state" },
      { do: "verify" },
      { do: "update-shell", to: { kind: "target" }, via: "external" },
      { do: "verify" },
    ],
  },
  {
    id: "stable-to-target-external",
    title: "current stable, seeded, reinstall-over to target",
    formats: ["targz"],
    steps: [
      { do: "install", version: { kind: "stable" } },
      { do: "seed-state" },
      { do: "verify" },
      { do: "update-shell", to: { kind: "target" }, via: "external" },
      { do: "verify" },
    ],
  },
  {
    id: "ancient-to-target-external",
    title: "pre-seam ancient release, seeded, reinstall-over to target",
    // Windows pending an APPDATA profile-continuity probe for pre-2.6.6.
    platforms: ["linux", "darwin"],
    formats: ["targz"],
    steps: [
      { do: "install", version: { kind: "ancient" } },
      { do: "seed-state" },
      { do: "verify" },
      { do: "update-shell", to: { kind: "target" }, via: "external" },
      { do: "verify" },
    ],
  },
  {
    id: "previous-to-target-squirrel",
    title: "previous release, seeded, in-app shell update to target",
    platforms: ["win32", "darwin"],
    steps: [
      { do: "install", version: { kind: "previous" } },
      { do: "seed-state" },
      { do: "verify" },
      { do: "update-shell", to: { kind: "target" }, via: "squirrel" },
      { do: "verify" },
    ],
  },
  {
    id: "bundle-chain",
    title: "target shell, seeded, bundle chain previous → latest",
    // The in-app bundle updater is format-independent; one format suffices.
    formats: ["targz"],
    steps: [
      { do: "install", version: { kind: "target" } },
      { do: "seed-state" },
      { do: "update-bundle", to: { kind: "bundle-previous" } },
      { do: "verify" },
      { do: "update-bundle", to: { kind: "bundle-latest" } },
      { do: "verify" },
    ],
  },
  {
    id: "previous-to-target-pkgmgr-flatpak",
    title: "previous flatpak, seeded, package-manager upgrade to target",
    platforms: ["linux"],
    formats: ["flatpak"],
    steps: [
      { do: "install", version: { kind: "previous" } },
      { do: "seed-state" },
      { do: "verify" },
      { do: "update-shell", to: { kind: "target" }, via: "pkgmgr" },
      { do: "verify" },
    ],
  },
  {
    id: "previous-to-target-pkgmgr-snap",
    title: "previous snap, seeded, package-manager upgrade to target",
    platforms: ["linux"],
    formats: ["snap"],
    steps: [
      { do: "install", version: { kind: "previous" } },
      { do: "seed-state" },
      { do: "verify" },
      { do: "update-shell", to: { kind: "target" }, via: "pkgmgr" },
      { do: "verify" },
    ],
  },
];

/** One channel's version stream in state/versions.json. */
export interface ChannelState {
  current: string;
  /** Newest-first, current included, deduped, capped. */
  history: string[];
}

/** Shape of state/versions.json — written only by scripts/version-watch.ts. */
export interface VersionState {
  updatedAt: string;
  shell: { stable: ChannelState; canary: ChannelState };
  bundle: { stable: ChannelState; canary: ChannelState };
}

export const VERSION_STATE_FILE = path.resolve("state", "versions.json");

export function readVersionState(
  file: string = VERSION_STATE_FILE,
): VersionState | undefined {
  if (!fs.existsSync(file)) {
    return undefined;
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as VersionState;
}

export interface ResolvedVersions {
  target?: string;
  previous?: string;
  stable?: string;
  ancient: string;
  bundleLatest?: string;
  bundlePrevious?: string;
}

/** First history entry differing from `current` — the previous version. */
function previousIn(channel: ChannelState | undefined): string | undefined {
  return channel?.history.find((v) => v !== channel.current);
}

/**
 * Resolves the selector inputs for a run: explicit env (what the trigger
 * workflow passes) wins, the committed watcher state fills the rest. No
 * live-feed fallback — a test run resolves against pinned inputs only;
 * discovering new versions is the watcher's job.
 */
export function resolveVersions(): ResolvedVersions {
  const state = readVersionState();
  const channel =
    (process.env.MIMIRI_CHANNEL as "stable" | "canary" | undefined) ?? "canary";
  const shell = state?.shell[channel];
  const bundle = state?.bundle[channel];
  const target = process.env.MIMIRI_TARGET_VERSION || shell?.current;
  const bundleLatest = process.env.MIMIRI_TARGET_BUNDLE || bundle?.current;
  return {
    target,
    previous: process.env.MIMIRI_PREVIOUS_VERSION || previousIn(shell),
    stable: state?.shell.stable.current,
    ancient: ANCIENT_BASE_VERSION,
    bundleLatest,
    bundlePrevious:
      bundle && bundleLatest
        ? bundle.history.find((v) => v !== bundleLatest)
        : undefined,
  };
}

/** Concrete version for a selector, or undefined when unresolvable. */
export function resolveSelector(
  selector: VersionSelector,
  rv: ResolvedVersions,
): string | undefined {
  switch (selector.kind) {
    case "target":
      return rv.target;
    case "previous":
      return rv.previous;
    case "stable":
      return rv.stable;
    case "ancient":
      return rv.ancient;
    case "bundle-latest":
      return rv.bundleLatest;
    case "bundle-previous":
      return rv.bundlePrevious;
    case "pin":
      return selector.version;
  }
}

export function scenarioAppliesTo(
  scenario: Scenario,
  platform: NodeJS.Platform,
  format: AppFormat,
): boolean {
  return (
    (scenario.platforms?.includes(platform) ?? true) &&
    (scenario.formats?.includes(format) ?? true)
  );
}

/**
 * All concrete versions a scenario needs, for artifact preparation and the
 * runner's existence guards. Returns undefined when any selector in the
 * scenario is unresolvable (→ self-skip / prep ignores it).
 */
export function scenarioVersions(
  scenario: Scenario,
  rv: ResolvedVersions,
): { shells: string[]; bundles: string[] } | undefined {
  const shells = new Set<string>();
  const bundles = new Set<string>();
  for (const step of scenario.steps) {
    const selector =
      step.do === "install"
        ? step.version
        : step.do === "update-bundle" || step.do === "update-shell"
          ? step.to
          : undefined;
    if (!selector) {
      continue;
    }
    const version = resolveSelector(selector, rv);
    if (!version) {
      return undefined;
    }
    (step.do === "update-bundle" ? bundles : shells).add(version);
  }
  return { shells: [...shells], bundles: [...bundles] };
}

/**
 * A bundle hop only sticks when the offered bundle is newer than the
 * shell's embedded base bundle (BundleManager discards older ones at
 * startup). Used by the runner to skip stale intermediate hops rather
 * than fail on them.
 */
export function bundleAboveBase(
  bundleVersion: string,
  baseVersion: string,
): boolean {
  const [maj, min, pat] = baseVersion.split(".").map(Number);
  return versionAtLeast(bundleVersion, maj, min, pat + 1);
}
