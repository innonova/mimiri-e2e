import http from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { AddressInfo } from "net";
import { gzipSync, gunzipSync } from "zlib";
import {
  Bundle,
  BundleFile,
  UPDATE_KEY_NAME,
  generateUpdateKeyPair,
  signBundle,
  signRaw,
  verifyBundleSignature,
  verifyRawSignature,
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
  /**
   * Arms (a version string) or disarms (null) the channel pointer. With
   * `hostUpdate` the offered version's minElectronVersion* fields are set
   * to the version itself (above any real shell), which sends the client
   * down the shell-update path (latest.json → electron-<os>.<v>.json →
   * installer package) instead of the plain bundle path. Requires
   * `shellNupkgPath` to have been passed to startUpdateServer.
   */
  setLatest(version: string | null, opts?: { hostUpdate?: boolean }): void;
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

const TEXT_EXTENSIONS = [".js", ".css", ".html", ".json", ".webmanifest"];

function isTextFile(name: string): boolean {
  return TEXT_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/** A distinct same-length stand-in for a content hash in an asset name. */
function mutateHash(hash: string): string {
  const reversed = [...hash].reverse().join("");
  return reversed === hash ? ("e2e" + hash).slice(0, hash.length) : reversed;
}

/**
 * Rewrites every quoted occurrence of the original version string inside the
 * bundle's .js files (file contents are gzip+base64). This changes the
 * version constant baked into the bundle at build time (src/version.ts), so
 * after activation the app observably reports the new version. The stamped
 * constant appears as a template literal (`2.6.4`) in the built output;
 * the other quote forms are covered for future-proofing.
 *
 * EVERY asset whose content changes — directly (the version rewrite) or
 * transitively (a reference to a renamed asset rewritten inside it) — is
 * also RENAMED and all references cascaded to a fixpoint, mimicking what a
 * real content-hashed build does. A file changing content behind an
 * unchanged app:// URL is a state no real update produces, and Chromium's
 * caches happily serve the stale copy after the activation reload: seen
 * once with the main chunk (stale page), and once more subtly with lazy
 * chunks whose rewritten imports kept their old names — a cached lazy
 * chunk then imported the OLD main chunk name and the app booted twice
 * into one document.
 */
function transformBundle(files: BundleFile[], from: string, to: string): void {
  const renames = new Map<string, string>();

  const renameIfHashed = (file: BundleFile): void => {
    const hashed = file.name.match(/^(.+)-([A-Za-z0-9_-]{6,16})\.js$/);
    if (hashed) {
      const newName = `${hashed[1]}-${mutateHash(hashed[2])}.js`;
      renames.set(file.name, newName);
      file.name = newName;
    }
  };

  const rewriteContents = (nodes: BundleFile[]): void => {
    for (const file of nodes) {
      if (file.files) {
        rewriteContents(file.files);
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
        if (replaced !== text) {
          renameIfHashed(file);
          file.content = gzipSync(Buffer.from(replaced, "utf8")).toString(
            "base64",
          );
        }
      }
    }
  };

  /** One reference-rewrite sweep; returns whether it produced NEW renames. */
  const rewriteReferences = (
    nodes: BundleFile[],
    pending: Map<string, string>,
    next: Map<string, string>,
  ): void => {
    for (const file of nodes) {
      if (file.files) {
        rewriteReferences(file.files, pending, next);
      } else if (isTextFile(file.name) && file.content) {
        const text = gunzipSync(Buffer.from(file.content, "base64")).toString(
          "utf8",
        );
        let replaced = text;
        for (const [oldName, newName] of pending) {
          replaced = replaced.split(oldName).join(newName);
        }
        if (replaced !== text) {
          // Content changed → this file needs a new name too (unless it
          // already got one this transform), and its own referrers need
          // rewriting in the next sweep.
          if (
            !new Set(renames.values()).has(file.name) &&
            !next.has(file.name)
          ) {
            const before = file.name;
            renameIfHashed(file);
            if (file.name !== before) {
              next.set(before, file.name);
            }
          }
          file.content = gzipSync(Buffer.from(replaced, "utf8")).toString(
            "base64",
          );
        }
      }
    }
  };

  rewriteContents(files);
  let pending = new Map(renames);
  while (pending.size > 0) {
    const next = new Map<string, string>();
    rewriteReferences(files, pending, next);
    pending = next;
  }
}

/**
 * The BundleInfo shape served for the channel pointer and .info.json.
 * With minVersion 0.0.0 the client always takes the plain-bundle path;
 * a minVersion above the shell's version sends it down the host-update
 * (shell installer) branch instead.
 */
function infoFor(
  bundle: Bundle,
  size: number,
  minVersion: string,
): Record<string, unknown> {
  return {
    version: bundle.version,
    description: bundle.description ?? "",
    releaseDate: bundle.releaseDate,
    size,
    minElectronVersion: minVersion,
    minElectronVersionWin32: minVersion,
    minElectronVersionDarwin: minVersion,
    minElectronVersionLinux: minVersion,
    minIosVersion: "0.0.0",
    minAndroidVersion: "0.0.0",
  };
}

export async function startUpdateServer(opts: {
  bundleJsonPath: string;
  /**
   * A Squirrel shell package to serve for shell updates: a full .nupkg on
   * Windows (typically the published package repacked to a higher version —
   * see win-squirrel.ts::repackNupkg) or a published darwin .zip on macOS
   * (a genuinely newer release — Squirrel.Mac validates the code signature,
   * so the payload must be a real signed build). Loaded, hashed and signed
   * lazily on the first shell-update request.
   */
  shellPackagePath?: string;
}): Promise<TestUpdateServer> {
  const bundle = JSON.parse(
    fs.readFileSync(opts.bundleJsonPath, "utf8"),
  ) as Bundle;
  const originalVersion = bundle.version;

  transformBundle(bundle.files, originalVersion, TEST_BUNDLE_VERSION);
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
  let hostUpdateArmed = false;
  let base = ""; // server base URL, set once listening
  const requests: string[] = [];

  // Shell (Squirrel) update fixture, lazily prepared: the client verifies
  // the raw installer bytes against ElectronInfo.signature, and Squirrel
  // itself checks the SHA1 from the RELEASES line.
  interface ShellFixture {
    fileName: string;
    bytes: Buffer;
    releasesLine: string;
    signature: string;
  }
  let shellFixturePromise: Promise<ShellFixture> | undefined;
  const shellFixture = (): Promise<ShellFixture> => {
    if (!shellFixturePromise) {
      shellFixturePromise = (async () => {
        if (!opts.shellPackagePath) {
          throw new Error(
            "update-server: shell update requested but no shellPackagePath was configured",
          );
        }
        const bytes = fs.readFileSync(opts.shellPackagePath);
        const fileName = path.basename(opts.shellPackagePath);
        const sha1 = crypto
          .createHash("sha1")
          .update(bytes)
          .digest("hex")
          .toUpperCase();
        const signature = await signRaw(bytes, keys.privateKey);
        if (
          !(await verifyRawSignature(signature, bytes, keys.publicKeyBase64))
        ) {
          throw new Error(
            "update-server: self-verification of installer signature failed",
          );
        }
        return {
          fileName,
          bytes,
          releasesLine: `${sha1} ${fileName} ${bytes.length}`,
          signature,
        };
      })();
    }
    return shellFixturePromise;
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      const reqPath = (req.url ?? "").split("?")[0];
      requests.push(`${req.method} ${reqPath}`);

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

      const electronInfo = reqPath.match(
        /^\/electron-(win|darwin)\.(.+)\.json$/,
      );
      const shellPackage = reqPath.match(/^\/(.+\.(nupkg|zip))$/);
      const fullBundle = reqPath.match(/^\/(.+)\.(\d+\.\d+\.\d+)\.json$/);
      const info = reqPath.match(/^\/(.+)\.(\d+\.\d+\.\d+)\.info\.json$/);
      const pointer = reqPath.match(/^\/(.+)\.(stable|canary)\.json$/);
      const minVersion = () =>
        hostUpdateArmed && armedVersion ? armedVersion : "0.0.0";

      if (reqPath === "/changelog.canary.json") {
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
      } else if (reqPath === "/latest.json") {
        if (hostUpdateArmed && armedVersion) {
          const systems: unknown[] = [];
          // Linux clients only ever read direct-download links (hrefs shown
          // in the UI, never fetched by the updater) — synthesize them so
          // the non-store host-update path has something to display.
          const linuxLinks = ["tar.gz", "AppImage", "flatpak", "snap"].map(
            (ext) => ({
              url: `${base}/mimiri-notes_${armedVersion}_amd64.${ext}`,
              name: `mimiri-notes_${armedVersion}_amd64.${ext}`,
            }),
          );
          systems.push({
            name: "Linux",
            links: linuxLinks,
            stable: linuxLinks,
            canary: linuxLinks,
          });
          if (opts.shellPackagePath) {
            // The client resolves the shell installer through the download
            // feed: it takes the last path segment of the platform's .json
            // and installer links and fetches them from its own update host.
            const fixture = await shellFixture();
            const os = fixture.fileName.endsWith(".zip") ? "darwin" : "win";
            const links = [
              {
                url: `${base}/electron-${os}.${armedVersion}.json`,
                name: `electron-${os}.${armedVersion}.json`,
              },
              {
                url: `${base}/${encodeURIComponent(fixture.fileName)}`,
                name: fixture.fileName,
              },
            ];
            systems.push(
              { name: "Windows", links, stable: links, canary: links },
              { name: "MacOS", links, stable: links, canary: links },
            );
          }
          json(JSON.stringify({ systems }));
        } else {
          // Only reached if the host-update branch is hit unexpectedly;
          // serving the committed feed copy keeps that failure diagnosable
          // rather than a hard 404 abort.
          json(fs.readFileSync("latest.json", "utf8"));
        }
      } else if (electronInfo) {
        const fixture = await shellFixture();
        json(
          JSON.stringify({
            // Windows stages a Squirrel RELEASES file from this; macOS
            // treats it as the local file name for releases.json.
            release:
              electronInfo[1] === "win"
                ? fixture.releasesLine
                : fixture.fileName,
            size: fixture.bytes.length,
            signatureKey: UPDATE_KEY_NAME,
            signature: fixture.signature,
          }),
        );
      } else if (shellPackage) {
        const fixture = await shellFixture();
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": fixture.bytes.length,
        });
        res.end(fixture.bytes);
      } else if (info) {
        const body = await signedBundle(info[1]);
        json(JSON.stringify(infoFor(bundle, body.length, minVersion())));
      } else if (fullBundle) {
        json(await signedBundle(fullBundle[1]));
      } else if (pointer) {
        const body = await signedBundle(pointer[1]);
        // The armed version may exceed the transformed bundle's own (e.g.
        // offering a host update on top of an already-applied 99.0.0).
        const pointerInfo = {
          ...infoFor(
            bundle,
            body.length,
            armedVersion ? minVersion() : "0.0.0",
          ),
          version: armedVersion ?? DISARMED_VERSION,
        };
        json(JSON.stringify(pointerInfo));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `no route for ${reqPath}` }));
      }
    })().catch((err) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;

  return {
    url: base,
    publicKeyBase64: keys.publicKeyBase64,
    bundleVersion: TEST_BUNDLE_VERSION,
    setLatest(version, setOpts) {
      armedVersion = version;
      hostUpdateArmed = !!version && !!setOpts?.hostUpdate;
    },
    requests,
    stop: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

/** A real published shell release servable for host (shell) updates. */
export interface PassthroughShellPackage {
  version: string;
  /** The real installer package: full .nupkg (win) / darwin .zip (mac). */
  packagePath: string;
  /** The real production-signed electron-<os>.<version>.json. */
  infoJsonPath: string;
}

export interface PassthroughUpdateServer {
  /** Base URL — value for MIMIRI_UPDATE_URL. Do NOT set MIMIRI_UPDATE_KEY:
   * everything served is production-signed and must validate against the
   * client's built-in key. */
  url: string;
  /** Arms the channel pointer with a REAL published version: a bundle
   * version for the plain-bundle path, or (with `hostUpdate`) a shell
   * version for the shell-update path. null disarms. */
  setLatest(version: string | null, opts?: { hostUpdate?: boolean }): void;
  requests: string[];
  stop(): Promise<void>;
}

/**
 * Passthrough variant of the mock update host, for the upgrade-flow suite
 * (tests/upgrade-flows.spec.ts): where startUpdateServer serves a
 * transformed re-signed bundle, this serves REAL published artifacts
 * byte-for-byte — bundle jsons and shell packages keep their production
 * signatures, so the app under test is only given MIMIRI_UPDATE_URL and
 * validates everything against its baked-in production key, exactly like
 * a real update. Only the unsigned metadata (channel pointer, .info.json,
 * latest.json, changelog) is synthesized, which is what makes arming a
 * specific version possible.
 */
export async function startPassthroughUpdateServer(opts: {
  /** bundle version → path of the real production-signed bundle json. */
  bundles?: Map<string, string>;
  shellPackages?: PassthroughShellPackage[];
}): Promise<PassthroughUpdateServer> {
  interface LoadedBundle {
    raw: string;
    bundle: Bundle;
  }
  const loadedBundles = new Map<string, LoadedBundle>();
  const loadBundle = (version: string): LoadedBundle | undefined => {
    let loaded = loadedBundles.get(version);
    if (!loaded) {
      const file = opts.bundles?.get(version);
      if (!file) {
        return undefined;
      }
      const raw = fs.readFileSync(file, "utf8");
      loaded = { raw, bundle: JSON.parse(raw) as Bundle };
      loadedBundles.set(version, loaded);
    }
    return loaded;
  };

  let armedVersion: string | null = null;
  let hostUpdateArmed = false;
  let base = "";
  const requests: string[] = [];

  /** BundleInfo for the pointer/info routes. Falls back to synthetic
   * fields when the armed version is a shell version with no bundle. */
  const pointerInfo = (): Record<string, unknown> => {
    const minVersion = hostUpdateArmed && armedVersion ? armedVersion : "0.0.0";
    const armedBundle = armedVersion ? loadBundle(armedVersion) : undefined;
    return {
      ...(armedBundle
        ? infoFor(armedBundle.bundle, armedBundle.raw.length, minVersion)
        : {
            description: "",
            releaseDate: new Date().toISOString(),
            size: 0,
            minElectronVersion: minVersion,
            minElectronVersionWin32: minVersion,
            minElectronVersionDarwin: minVersion,
            minElectronVersionLinux: minVersion,
            minIosVersion: "0.0.0",
            minAndroidVersion: "0.0.0",
          }),
      version: armedVersion ?? DISARMED_VERSION,
    };
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      const reqPath = decodeURIComponent((req.url ?? "").split("?")[0]);
      requests.push(`${req.method} ${reqPath}`);

      // Same CORS story as startUpdateServer: the renderer origin plus the
      // X-Mimiri-Version header force a preflight on every request.
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
      const notFound = () => {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `no route for ${reqPath}` }));
      };

      const electronInfo = reqPath.match(
        /^\/electron-(win|darwin)\.(.+)\.json$/,
      );
      const shellPackage = reqPath.match(/^\/(.+\.(nupkg|zip))$/);
      const info = reqPath.match(/^\/(.+)\.(\d+\.\d+\.\d+)\.info\.json$/);
      const fullBundle = reqPath.match(/^\/(.+)\.(\d+\.\d+\.\d+)\.json$/);
      const pointer = reqPath.match(/^\/(.+)\.(stable|canary)\.json$/);

      if (reqPath === "/changelog.canary.json") {
        json(JSON.stringify({ versions: [] }));
      } else if (reqPath === "/latest.json") {
        const systems: unknown[] = [];
        const version = armedVersion ?? DISARMED_VERSION;
        const linuxLinks = ["tar.gz", "AppImage", "flatpak", "snap"].map(
          (ext) => ({
            url: `${base}/mimiri-notes_${version}_amd64.${ext}`,
            name: `mimiri-notes_${version}_amd64.${ext}`,
          }),
        );
        systems.push({
          name: "Linux",
          links: linuxLinks,
          stable: linuxLinks,
          canary: linuxLinks,
        });
        const pkg = opts.shellPackages?.find((p) => p.version === version);
        if (pkg) {
          const os = pkg.packagePath.endsWith(".zip") ? "darwin" : "win";
          const fileName = path.basename(pkg.packagePath);
          const links = [
            {
              url: `${base}/electron-${os}.${version}.json`,
              name: `electron-${os}.${version}.json`,
            },
            {
              url: `${base}/${encodeURIComponent(fileName)}`,
              name: fileName,
            },
          ];
          systems.push(
            { name: "Windows", links, stable: links, canary: links },
            { name: "MacOS", links, stable: links, canary: links },
          );
        }
        json(JSON.stringify({ systems }));
      } else if (electronInfo) {
        const pkg = opts.shellPackages?.find(
          (p) => p.version === electronInfo[2],
        );
        if (!pkg) {
          notFound();
          return;
        }
        json(fs.readFileSync(pkg.infoJsonPath, "utf8"));
      } else if (shellPackage) {
        const pkg = opts.shellPackages?.find(
          (p) => path.basename(p.packagePath) === shellPackage[1],
        );
        if (!pkg) {
          notFound();
          return;
        }
        const bytes = fs.readFileSync(pkg.packagePath);
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": bytes.length,
        });
        res.end(bytes);
      } else if (info) {
        // The download step re-fetches the ARMED version's info.json and
        // routes on its minElectronVersion (bundle vs shell installer) —
        // serve it with the same semantics as the pointer, including for
        // armed shell versions that have no bundle at all.
        if (info[2] === armedVersion) {
          json(JSON.stringify(pointerInfo()));
          return;
        }
        const loaded = loadBundle(info[2]);
        if (!loaded) {
          notFound();
          return;
        }
        json(
          JSON.stringify(infoFor(loaded.bundle, loaded.raw.length, "0.0.0")),
        );
      } else if (fullBundle) {
        const loaded = loadBundle(fullBundle[2]);
        if (!loaded) {
          notFound();
          return;
        }
        json(loaded.raw);
      } else if (pointer) {
        json(JSON.stringify(pointerInfo()));
      } else {
        notFound();
      }
    })().catch((err) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;

  return {
    url: base,
    setLatest(version, setOpts) {
      armedVersion = version;
      hostUpdateArmed = !!version && !!setOpts?.hostUpdate;
    },
    requests,
    stop: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
