import { _electron as electron, ElectronApplication } from "playwright";
import path from "path";
import os from "os";
import fs from "fs";

export function executablePath(version = "current"): string {
  const root = path.join("artifacts", version);
  switch (process.platform) {
    case "darwin":
      return path.join(root, "YourApp.app/Contents/MacOS/YourApp");
    case "win32":
      return path.join(root, "win-unpacked/YourApp.exe");
    default:
      return path.join(root, "linux-unpacked/yourapp");
  }
}

export async function launchApp(
  opts: { version?: string; userDataDir?: string } = {},
) {
  const userDataDir =
    opts.userDataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "e2e-")); // fresh by default
  const app = await electron.launch({
    executablePath: executablePath(opts.version),
    args: [`--user-data-dir=${userDataDir}`], // or however your app accepts it
    env: { ...process.env, APP_TEST_MODE: "1" }, // your "small accommodation" seam
  });
  return { app, userDataDir };
}
