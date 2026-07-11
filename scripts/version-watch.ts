/**
 * Polls update.mimiri.io for the current shell and bundle versions per
 * channel, diffs them against the committed watcher state
 * (state/versions.json) and updates it — accumulating the version history
 * the update host itself does not expose, which is what makes the
 * `previous` / `bundle-previous` selectors of the upgrade-flow scenarios
 * resolvable.
 *
 * Run by .github/workflows/version-watch.yml on a schedule; on a change the
 * workflow commits the state file and dispatches upgrade-validation with
 * the outputs this script writes to $GITHUB_OUTPUT.
 *
 * Usage:
 *   npx tsx scripts/version-watch.ts             # update state file
 *   npx tsx scripts/version-watch.ts --dry-run   # report only, write nothing
 */
import fs from "fs";
import path from "path";
import {
  ChannelState,
  VERSION_STATE_FILE,
  VersionState,
  readVersionState,
} from "../helpers/upgrade-flows";
import { UPDATE_KEY_NAME } from "../helpers/bundle-crypto";

const UPDATE_HOST = "https://update.mimiri.io";
const HISTORY_CAP = 20;

type Channel = "stable" | "canary";

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

/**
 * Shell version a channel currently points at, parsed from the Windows
 * entry of the download feed (every platform's links carry the same shell
 * version; Windows is arbitrary but always present).
 */
function shellVersionFromFeed(systems: FeedSystem[], channel: Channel): string {
  const system = systems.find((s) => s.name === "Windows");
  if (!system) {
    throw new Error(`no "Windows" entry in ${UPDATE_HOST}/latest.json`);
  }
  const links = system[channel] ?? system.links;
  for (const link of links) {
    const match = link.name.match(/(\d+\.\d+\.\d+)/);
    if (match) {
      return match[1];
    }
  }
  throw new Error(`no versioned ${channel} link in the Windows feed entry`);
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`failed to fetch ${url}: HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

/** Returns the updated channel state, or undefined when nothing changed. */
function advance(
  state: ChannelState,
  observed: string,
): ChannelState | undefined {
  if (state.current === observed && state.history[0] === observed) {
    return undefined;
  }
  return {
    current: observed,
    history: [observed, ...state.history.filter((v) => v !== observed)].slice(
      0,
      HISTORY_CAP,
    ),
  };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const state = readVersionState();
  if (!state) {
    throw new Error(
      `${VERSION_STATE_FILE} not found — the watcher only advances existing state`,
    );
  }

  const feed = await fetchJson<{ systems: FeedSystem[] }>(
    `${UPDATE_HOST}/latest.json`,
  );
  const observed = {
    shell: {
      stable: shellVersionFromFeed(feed.systems, "stable"),
      canary: shellVersionFromFeed(feed.systems, "canary"),
    },
    bundle: {
      stable: (
        await fetchJson<{ version: string }>(
          `${UPDATE_HOST}/${UPDATE_KEY_NAME}.stable.json`,
        )
      ).version,
      canary: (
        await fetchJson<{ version: string }>(
          `${UPDATE_HOST}/${UPDATE_KEY_NAME}.canary.json`,
        )
      ).version,
    },
  };

  const changes: string[] = [];
  const next: VersionState = {
    updatedAt: state.updatedAt,
    shell: { ...state.shell },
    bundle: { ...state.bundle },
  };
  for (const stream of ["shell", "bundle"] as const) {
    for (const channel of ["stable", "canary"] as const) {
      const advanced = advance(
        state[stream][channel],
        observed[stream][channel],
      );
      if (advanced) {
        changes.push(
          `${stream}.${channel}: ${state[stream][channel].current} -> ${advanced.current}`,
        );
        next[stream][channel] = advanced;
      }
    }
  }

  for (const line of changes) {
    console.log(`[version-watch] ${line}`);
  }
  if (changes.length === 0) {
    console.log("[version-watch] no changes");
  } else if (dryRun) {
    console.log("[version-watch] dry run — state file not written");
  } else {
    next.updatedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(VERSION_STATE_FILE), { recursive: true });
    fs.writeFileSync(VERSION_STATE_FILE, JSON.stringify(next, null, 2) + "\n");
    console.log(`[version-watch] wrote ${VERSION_STATE_FILE}`);
  }

  if (process.env.GITHUB_OUTPUT) {
    // The validation run targets the canary channel (what CI tests); the
    // previous_* values are what users were on before this publish.
    const out = [
      `changed=${changes.length > 0}`,
      `target_shell=${next.shell.canary.current}`,
      `previous_shell=${next.shell.canary.history.find((v) => v !== next.shell.canary.current) ?? ""}`,
      `target_bundle=${next.bundle.canary.current}`,
      `previous_bundle=${next.bundle.canary.history.find((v) => v !== next.bundle.canary.current) ?? ""}`,
    ];
    fs.appendFileSync(process.env.GITHUB_OUTPUT, out.join("\n") + "\n");
  }
}

main().catch((err) => {
  console.error("[version-watch] failed:", err);
  process.exitCode = 1;
});
