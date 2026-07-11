/**
 * Prepares every artifact an upgrade-flow run needs: resolves the scenario
 * table's version selectors, then fetches each shell version via
 * fetch-artifact (cached/idempotent) and each real bundle json into
 * artifacts/bundles/<version>.json.
 *
 * Usage:
 *   npm run prepare-upgrade [-- --format=targz] [--scenario=id,id]
 *
 * Version inputs come from MIMIRI_TARGET_VERSION / MIMIRI_PREVIOUS_VERSION /
 * MIMIRI_TARGET_BUNDLE env (what the CI trigger passes) with
 * state/versions.json filling the rest — same resolution the runner uses.
 *
 * flatpak/snap note: fetch-artifact INSTALLS what it fetches and only one
 * version can be installed at a time, so shell versions are fetched in
 * DESCENDING order — the oldest (the scenario's starting point) ends up
 * installed, and the mid-test upgrade re-invokes fetch-artifact for the
 * target against an already-cached download.
 */
import fs from "fs";
import path from "path";
import { resolveFormat } from "../helpers/format";
import {
  homeLayoutAvailable,
  needsHomeLayout,
  resolveVersions,
  runFetchArtifact,
  scenarioAppliesTo,
  scenarioVersions,
  scenarios,
} from "../helpers/upgrade-flows";
import {
  Bundle,
  PRODUCTION_UPDATE_PUBLIC_KEY,
  UPDATE_KEY_NAME,
  verifyBundleSignature,
} from "../helpers/bundle-crypto";

const UPDATE_HOST = "https://update.mimiri.io";
export const UPGRADE_BUNDLES_DIR = path.resolve("artifacts", "bundles");

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
}

function fetchArtifact(version: string, format: string): void {
  console.log(`[prepare-upgrade] fetch ${version} (${format})`);
  runFetchArtifact(version, format);
}

async function fetchRealBundle(version: string): Promise<void> {
  const file = path.join(UPGRADE_BUNDLES_DIR, `${version}.json`);
  if (fs.existsSync(file)) {
    console.log(`[prepare-upgrade] bundle ${version} already present`);
    return;
  }
  const url = `${UPDATE_HOST}/${UPDATE_KEY_NAME}.${version}.json`;
  console.log(`[prepare-upgrade] downloading bundle ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`failed to fetch bundle ${version}: HTTP ${res.status}`);
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
      `bundle ${version} failed signature verification against the ` +
        `production update key`,
    );
  }
  fs.mkdirSync(UPGRADE_BUNDLES_DIR, { recursive: true });
  fs.writeFileSync(file, text);
}

/** Real production-signed shell-update descriptor, for squirrel flows. */
async function fetchElectronInfo(version: string): Promise<void> {
  const os = process.platform === "win32" ? "win" : "darwin";
  const name = `electron-${os}.${version}.json`;
  const file = path.resolve("artifacts", "downloads", name);
  if (fs.existsSync(file)) {
    return;
  }
  console.log(`[prepare-upgrade] downloading ${name}`);
  const res = await fetch(`${UPDATE_HOST}/${name}`);
  if (!res.ok) {
    throw new Error(`failed to fetch ${name}: HTTP ${res.status}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, await res.text());
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const format = resolveFormat(
    args.find((a) => a.startsWith("--format="))?.slice("--format=".length),
  );
  const scenarioFilter = args
    .find((a) => a.startsWith("--scenario="))
    ?.slice("--scenario=".length)
    .split(",");

  const rv = resolveVersions();
  console.log(`[prepare-upgrade] resolved versions:`, rv);

  const shells = new Set<string>();
  const bundles = new Set<string>();
  let squirrel = false;
  for (const scenario of scenarios) {
    if (scenarioFilter && !scenarioFilter.includes(scenario.id)) {
      continue;
    }
    if (!scenarioAppliesTo(scenario, process.platform, format)) {
      continue;
    }
    const versions = scenarioVersions(scenario, rv);
    if (!versions) {
      console.log(
        `[prepare-upgrade] ${scenario.id}: selectors unresolvable, skipping`,
      );
      continue;
    }
    if (
      needsHomeLayout(versions.shells) &&
      !homeLayoutAvailable(process.platform, format)
    ) {
      // The runner will skip it too — don't download its artifacts.
      console.log(
        `[prepare-upgrade] ${scenario.id}: home-layout profile not ` +
          `available here, skipping`,
      );
      continue;
    }
    versions.shells.forEach((v) => shells.add(v));
    versions.bundles.forEach((v) => bundles.add(v));
    if (
      scenario.steps.some(
        (s) => s.do === "update-shell" && s.via === "squirrel",
      )
    ) {
      squirrel = true;
    }
  }

  // Descending, so package-manager formats end with the OLDEST installed.
  const shellList = [...shells].sort(compareVersions).reverse();
  console.log(
    `[prepare-upgrade] shells: ${shellList.join(", ") || "none"}; ` +
      `bundles: ${[...bundles].join(", ") || "none"}`,
  );
  for (const version of shellList) {
    fetchArtifact(version, format);
  }
  for (const version of bundles) {
    await fetchRealBundle(version);
  }
  if (squirrel && rv.target && process.platform !== "linux") {
    await fetchElectronInfo(rv.target);
  }

  // fetch-artifact points current.json at whatever it fetched last; make
  // sure a plain test run in this workspace still targets the target.
  if (rv.target) {
    fs.writeFileSync(
      path.resolve("artifacts", "current.json"),
      JSON.stringify({ version: rv.target, format }, null, 2),
    );
  }
  console.log("[prepare-upgrade] done");
}

main().catch((err) => {
  console.error("[prepare-upgrade] failed:", err);
  process.exitCode = 1;
});
