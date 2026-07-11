import { test, expect } from "@playwright/test";
import { spawnSync } from "child_process";
import path from "path";
import { loadMeta } from "../helpers/app";

/**
 * Asserts the fetched macOS artifact is correctly signed and notarized —
 * the part of the "user downloads from the website" flow that CANNOT be
 * simulated by the upgrade tests (our harness downloads carry no quarantine
 * xattr, so Gatekeeper never runs during them). A broken signature or
 * notarization would brick real browser downloads while every e2e test
 * stays green; these checks catch that directly on the artifact.
 */

function run(
  cmd: string,
  args: string[],
): { status: number | null; out: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}`.trim() };
}

test.describe("mac artifact signing", () => {
  test("fetched .app is signed, notarized and Gatekeeper-accepted", async () => {
    test.skip(process.platform !== "darwin", "macOS-only");
    const meta = loadMeta();
    const appBundle = path.resolve(
      "artifacts",
      meta.version,
      "Mimiri Notes.app",
    );

    const codesign = run("codesign", [
      "--verify",
      "--deep",
      "--strict",
      appBundle,
    ]);
    expect(codesign.status, `codesign: ${codesign.out}`).toBe(0);

    const spctl = run("spctl", ["--assess", "--type", "execute", appBundle]);
    expect(spctl.status, `spctl: ${spctl.out}`).toBe(0);

    const stapler = run("xcrun", ["stapler", "validate", appBundle]);
    expect(stapler.status, `stapler: ${stapler.out}`).toBe(0);
  });
});
