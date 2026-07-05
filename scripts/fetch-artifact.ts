/**
 * Fetches / prepares the packaged Electron application under `artifacts/<version>`
 * so the e2e suite has something to launch.
 *
 * This is a placeholder scaffold — the actual download/extraction logic still
 * needs to be implemented.
 */
import path from "path";

const version = process.argv[2] ?? "current";
const targetDir = path.join("artifacts", version);

async function main(): Promise<void> {
  console.log(`[fetch-artifact] target version: ${version}`);
  console.log(`[fetch-artifact] target directory: ${targetDir}`);
  // TODO: download the packaged app and extract it into `targetDir`.
  throw new Error("fetch-artifact is not implemented yet");
}

main().catch((err) => {
  console.error(`[fetch-artifact] failed:`, err);
  process.exitCode = 1;
});
