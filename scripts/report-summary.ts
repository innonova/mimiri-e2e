/**
 * Summarize a Playwright JSON report (test-results/report.json) for CI.
 *
 * Written for the always-run summary step in the workflows: makes flaky
 * passes (retry-passes) and skipped tests visible on green runs — both are
 * otherwise only discoverable by downloading the HTML report — and surfaces
 * the shell's embedded base bundle version (annotated by the smoke test),
 * which gates when the upgrade-flows bundle-chain scenario comes alive.
 *
 * Output goes to $GITHUB_STEP_SUMMARY when set (plus ::warning:: workflow
 * commands for flaky tests) and always to stdout, so it is usable locally:
 *
 *   npx tsx scripts/report-summary.ts [path/to/report.json]
 */
import fs from "fs";

interface JsonAnnotation {
  type: string;
  description?: string;
}

interface JsonTest {
  status: string; // "expected" | "unexpected" | "flaky" | "skipped"
  annotations?: JsonAnnotation[];
}

interface JsonSpec {
  title: string;
  tests?: JsonTest[];
}

interface JsonSuite {
  title: string;
  suites?: JsonSuite[];
  specs?: JsonSpec[];
}

interface JsonReport {
  suites?: JsonSuite[];
  stats?: Record<string, number | string>;
}

const reportPath = process.argv[2] ?? "test-results/report.json";
if (!fs.existsSync(reportPath)) {
  console.log(`report-summary: no report at ${reportPath}, nothing to do`);
  process.exit(0);
}
const report: JsonReport = JSON.parse(fs.readFileSync(reportPath, "utf8"));

interface Entry {
  name: string;
  reason?: string;
}
const flaky: Entry[] = [];
const skipped: Entry[] = [];
let baseVersion: string | undefined;

function walk(suite: JsonSuite, trail: string[]): void {
  const here = [...trail, suite.title].filter(Boolean);
  for (const child of suite.suites ?? []) walk(child, here);
  for (const spec of suite.specs ?? []) {
    const name = [...here, spec.title].join(" › ");
    for (const test of spec.tests ?? []) {
      const skipAnnotation = (test.annotations ?? []).find(
        (a) => a.type === "skip",
      );
      if (test.status === "flaky") flaky.push({ name });
      if (test.status === "skipped")
        skipped.push({ name, reason: skipAnnotation?.description });
      for (const a of test.annotations ?? []) {
        if (a.type === "base-bundle-version") baseVersion = a.description;
      }
    }
  }
}
for (const suite of report.suites ?? []) walk(suite, []);

const lines: string[] = [];
lines.push(`## Test summary`);
lines.push("");
const stats = report.stats ?? {};
lines.push(
  `passed ${stats.expected ?? "?"} · failed ${stats.unexpected ?? "?"} · ` +
    `flaky ${flaky.length} · skipped ${skipped.length}`,
);
if (baseVersion) {
  lines.push("");
  lines.push(
    `Embedded base bundle: **${baseVersion}** ` +
      `(bundle-chain needs ≥ 2.6.9 — see docs/backlog.md)`,
  );
}
if (flaky.length > 0) {
  lines.push("");
  lines.push(`### Flaky (passed on retry — a timing race is hiding here)`);
  lines.push("");
  for (const f of flaky) lines.push(`- ${f.name}`);
}
if (skipped.length > 0) {
  lines.push("");
  lines.push(`### Skipped`);
  lines.push("");
  for (const s of skipped)
    lines.push(`- ${s.name}${s.reason ? ` — ${s.reason}` : ""}`);
}
lines.push("");

const summary = lines.join("\n");
console.log(summary);

if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
}
if (process.env.GITHUB_ACTIONS) {
  for (const f of flaky) {
    console.log(`::warning title=Flaky test::${f.name} passed only on retry`);
  }
}
