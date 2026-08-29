import fs from "fs";
import path from "path";

/**
 * Records a feature demo for a pull request:
 *
 *   npm run capture -- <name>          # runs capture/captures/<name>.ts
 *   npm run capture                    # lists available captures
 *
 * Each capture module default-exports an async function that drives the app
 * (launchApp + the usual helpers), records it, and returns the produced
 * files. Outputs land in capture/out/; publish them with
 * scripts/pr-media.sh, which prints the markdown for the PR body.
 */

async function main(): Promise<void> {
  const dir = path.resolve("capture", "captures");
  const name = process.argv[2];
  if (!name) {
    const available = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => f.replace(/\.ts$/, ""));
    console.log("available captures:\n  " + available.join("\n  "));
    process.exit(1);
  }
  const file = path.join(dir, `${name}.ts`);
  if (!fs.existsSync(file)) {
    console.error(`no capture named "${name}" (${file})`);
    process.exit(1);
  }

  // ELECTRON_RUN_AS_NODE leaks from VSCode-descended shells and breaks the app.
  delete process.env.ELECTRON_RUN_AS_NODE;

  const mod = (await import(file)) as {
    default: () => Promise<Record<string, string>>;
  };
  const started = Date.now();
  const produced = await mod.default();
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`\n${name}: done in ${seconds}s`);
  for (const [kind, f] of Object.entries(produced)) {
    const size = (fs.statSync(f).size / 1024 / 1024).toFixed(2);
    console.log(`  ${kind.padEnd(4)} ${f}  (${size} MB)`);
  }
  console.log(
    `\npublish:\n  scripts/pr-media.sh -r <repo> -c "<caption>" ${Object.values(produced).join(" ")}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
