import { test, expect } from "@playwright/test";
import { spawnSync } from "child_process";
import fs from "fs";
import { loadMeta } from "../helpers/app";
import { winShellArtifacts } from "../helpers/win-squirrel";

/**
 * Asserts the fetched Windows Setup.exe carries a valid, timestamped
 * Authenticode signature from the expected publisher — the Windows
 * counterpart of mac-signing.spec.ts. Nothing else in the suite would
 * notice a broken signature (Squirrel validates only the RELEASES SHA1),
 * but real users would: SmartScreen and Defender treat an unsigned or
 * badly signed installer download very differently from a signed one.
 *
 * Deliberately limited to Setup.exe: the binaries inside the nupkg (the
 * app exe, the execution stub, squirrel.exe) have always shipped unsigned
 * (verified back to 2.5.72), so asserting on them would just be permanently
 * red. If the build pipeline ever starts signing them, extend this spec.
 */

interface AuthenticodeInfo {
  Status: string;
  Subject: string;
  Timestamped: boolean;
}

function authenticode(file: string): AuthenticodeInfo {
  const script =
    `$s = Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}'; ` +
    `[pscustomobject]@{ Status = $s.Status.ToString(); ` +
    `Subject = if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { '' }; ` +
    `Timestamped = $null -ne $s.TimeStamperCertificate } | ConvertTo-Json`;
  // CI runners export a PowerShell-7 PSModulePath; Windows PowerShell 5.1
  // then autoloads the Core build of Microsoft.PowerShell.Security and dies
  // with CouldNotAutoloadMatchingModule. Drop the variable so 5.1 rebuilds
  // its own default module path.
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "psmodulepath") {
      delete env[key];
    }
  }
  const r = spawnSync("powershell", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    env,
  });
  if (r.status !== 0) {
    throw new Error(`Get-AuthenticodeSignature failed: ${r.stderr}`);
  }
  return JSON.parse(r.stdout) as AuthenticodeInfo;
}

test.describe("windows artifact signing", () => {
  test("fetched Setup.exe is Authenticode-signed by the publisher", async () => {
    test.skip(process.platform !== "win32", "Windows-only");
    const meta = loadMeta();
    const { setupExe } = winShellArtifacts(meta.version);
    test.skip(
      !fs.existsSync(setupExe),
      "Setup.exe not downloaded — re-run npm run fetch",
    );

    const sig = authenticode(setupExe);
    expect(sig.Status, `signature status of ${setupExe}`).toBe("Valid");
    expect(sig.Subject, "signer subject").toContain("CN=innonova GmbH");
    // Without a countersigned timestamp the signature dies with the cert;
    // installers already in the wild would start tripping SmartScreen.
    expect(sig.Timestamped, "signature is timestamped").toBe(true);
  });
});
