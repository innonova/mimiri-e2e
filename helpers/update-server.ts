import http from "http";
import fs from "fs";
import { AddressInfo } from "net";
import { gzipSync, gunzipSync } from "zlib";
import {
  Bundle,
  BundleFile,
  generateUpdateKeyPair,
  signBundle,
  verifyBundleSignature,
} from "./bundle-crypto";

/**
 * Local stand-in for update.mimiri.io. Serves a real published bundle
 * (artifacts/<version>/bundle.json, written by fetch-artifact) with its
 * version bumped and re-signed with a per-run test key. The app under test
 * is pointed here with MIMIRI_UPDATE_URL and accepts the signature via
 * MIMIRI_UPDATE_KEY (client seams, 2.6.9+).
 *
 * The channel pointer starts "disarmed" (offering a version older than
 * anything installed) so the update checks the app fires on startup and
 * login are no-ops; setLatest() arms it when the test is ready to observe
 * the flow.
 */
export interface TestUpdateServer {
  /** Base URL, e.g. http://127.0.0.1:39241 — value for MIMIRI_UPDATE_URL. */
  url: string;
  /** Test public key (single-line base64) — value for MIMIRI_UPDATE_KEY. */
  publicKeyBase64: string;
  /** The version the transformed bundle reports (TEST_BUNDLE_VERSION). */
  bundleVersion: string;
  /** Arms (a version string) or disarms (null) the channel pointer. */
  setLatest(version: string | null): void;
  /** Request paths observed, for debugging failed flows. */
  requests: string[];
  stop(): Promise<void>;
}

/**
 * Far above any real release, plain semver (the -beta/rc quirks in the
 * version comparers never engage), and above the shell's baked baseVersion
 * so the startup fallback in BundleManager never discards it.
 */
export const TEST_BUNDLE_VERSION = "99.0.0";

/** Version the disarmed channel pointer offers — older than any release. */
const DISARMED_VERSION = "0.0.1";

/**
 * Rewrites every quoted occurrence of the original version string inside the
 * bundle's .js files (file contents are gzip+base64). This changes the
 * version constant baked into the bundle at build time (src/version.ts), so
 * after activation the app observably reports the new version. The stamped
 * constant appears as a template literal (`2.6.4`) in the built output;
 * the other quote forms are covered for future-proofing.
 */
function rewriteVersion(files: BundleFile[], from: string, to: string): void {
  for (const file of files) {
    if (file.files) {
      rewriteVersion(file.files, from, to);
    } else if (file.name.endsWith(".js") && file.content) {
      const text = gunzipSync(Buffer.from(file.content, "base64")).toString(
        "utf8",
      );
      let replaced = text;
      for (const quote of ['"', "'", "`"]) {
        replaced = replaced
          .split(`${quote}${from}${quote}`)
          .join(`${quote}${to}${quote}`);
      }
      file.content = gzipSync(Buffer.from(replaced, "utf8")).toString("base64");
    }
  }
}

/**
 * The BundleInfo shape served for the channel pointer and .info.json. All
 * min versions are 0.0.0 so the client always takes the plain-bundle path,
 * never the host-update branch.
 */
function infoFor(bundle: Bundle, size: number): Record<string, unknown> {
  return {
    version: bundle.version,
    description: bundle.description ?? "",
    releaseDate: bundle.releaseDate,
    size,
    minElectronVersion: "0.0.0",
    minElectronVersionWin32: "0.0.0",
    minElectronVersionDarwin: "0.0.0",
    minElectronVersionLinux: "0.0.0",
    minIosVersion: "0.0.0",
    minAndroidVersion: "0.0.0",
  };
}

export async function startUpdateServer(opts: {
  bundleJsonPath: string;
}): Promise<TestUpdateServer> {
  const bundle = JSON.parse(
    fs.readFileSync(opts.bundleJsonPath, "utf8"),
  ) as Bundle;
  const originalVersion = bundle.version;

  rewriteVersion(bundle.files, originalVersion, TEST_BUNDLE_VERSION);
  bundle.version = TEST_BUNDLE_VERSION;
  bundle.releaseDate = new Date().toISOString();

  const keys = await generateUpdateKeyPair();
  // Serialized signed bundles per key name (in practice one — the name is
  // parsed from the request path so it always matches a baked-in key).
  const signedByName = new Map<string, Promise<string>>();
  const signedBundle = (name: string): Promise<string> => {
    let promise = signedByName.get(name);
    if (!promise) {
      promise = (async () => {
        await signBundle(bundle, name, keys.privateKey);
        // Self-check with the client's exact verify sequence — catches
        // padding/serialization regressions without launching the app.
        if (
          !(await verifyBundleSignature(bundle, name, keys.publicKeyBase64))
        ) {
          throw new Error(
            "update-server: self-verification of signature failed",
          );
        }
        return JSON.stringify(bundle);
      })();
      signedByName.set(name, promise);
    }
    return promise;
  };

  let armedVersion: string | null = null;
  const requests: string[] = [];

  const server = http.createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? "").split("?")[0];
      requests.push(`${req.method} ${path}`);

      // The renderer origin is app://app.mimernotes.com and every request
      // carries the custom X-Mimiri-Version header, which forces a CORS
      // preflight — without these headers every fetch fails opaquely.
      res.setHeader("Access-Control-Allow-Origin", "*");
      if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        res.setHeader(
          "Access-Control-Allow-Headers",
          req.headers["access-control-request-headers"] ??
            "X-Mimiri-Version, Content-Type",
        );
        res.writeHead(204);
        res.end();
        return;
      }

      const json = (body: string) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(body);
      };

      const fullBundle = path.match(/^\/(.+)\.(\d+\.\d+\.\d+)\.json$/);
      const info = path.match(/^\/(.+)\.(\d+\.\d+\.\d+)\.info\.json$/);
      const pointer = path.match(/^\/(.+)\.(stable|canary)\.json$/);

      if (path === "/changelog.canary.json") {
        // Served even when disarmed: updateChangeLog() runs at the end of
        // every check() and a 404 would abort it mid-flight.
        const versions = armedVersion
          ? [
              {
                version: armedVersion,
                releaseDate: bundle.releaseDate,
                features: [{ text: "E2E injected update" }],
                fixes: [],
              },
            ]
          : [];
        json(JSON.stringify({ versions }));
      } else if (path === "/latest.json") {
        // Only reached if the host-update branch is ever hit; serving the
        // committed feed copy keeps that failure diagnosable rather than a
        // hard 404 abort.
        json(fs.readFileSync("latest.json", "utf8"));
      } else if (info) {
        const body = await signedBundle(info[1]);
        json(JSON.stringify(infoFor(bundle, body.length)));
      } else if (fullBundle) {
        json(await signedBundle(fullBundle[1]));
      } else if (pointer) {
        const body = await signedBundle(pointer[1]);
        const pointerInfo = armedVersion
          ? infoFor(bundle, body.length)
          : { ...infoFor(bundle, body.length), version: DISARMED_VERSION };
        json(JSON.stringify(pointerInfo));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `no route for ${path}` }));
      }
    })().catch((err) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    publicKeyBase64: keys.publicKeyBase64,
    bundleVersion: TEST_BUNDLE_VERSION,
    setLatest(version) {
      armedVersion = version;
    },
    requests,
    stop: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
