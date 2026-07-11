# Testing unreleased changes

How to e2e-test client or shell changes *before* they're published — and the
release mechanics of the sibling repos that make the recipes make sense.

## Release mechanics (sibling repos)

- **mimiri-client** (Vue renderer): the current dev/PR target is the
  `canary-markdown` branch (not main); it publishes bundles to the canary
  channel. Bump the patch version in `package.json` when making a new version.
- **mimiri-client-electron** (shell): merging/pushing to `main` IS the release
  — a fresh build ships with the `package.json` version. After bumping, run
  `npm run update-bundle`; it embeds the latest *published canary* bundle as
  base (so publish client changes first if the embedded bundle must include
  them) and regenerates `bundle-info.json` + `src/base-version.ts`.
- Bundle and shell versions are **separate streams** (e.g. shell 2.6.10 ships
  bundle 2.6.5). Bundles live at
  `update.mimiri.io/2024101797F6C918.<version>.json`; there is often no bundle
  matching a shell version (fetch-artifact falls back to the channel pointer's
  version).

## Client-only changes: the fast path

Verifying unreleased **client** (bundle) changes doesn't need a shell build —
bundle-update a published shell into your local build:

1. In `mimiri-client`: `cp .env.example .env`, `node scripts/set-version.js`
   (stamps `src/version.ts` from package.json — revert after), then
   `npm run build-only` → `dist/`.
2. Wrap `dist/` as a bundle.json — the recursive gzip+base64 shape is in
   `helpers/update-server.ts`. Signatures don't matter: the mock re-signs.
3. Point `startUpdateServer({ bundleJsonPath })` at it and drive a published
   shell through a normal bundle update.

Much faster than the full local-shell recipe below.

## Shell changes: building a local targz

For unreleased **shell** (electron) changes, build a local targz and stage it
as an artifact:

1. Build the client dist as above (or skip if shell-only and the embedded
   base bundle suffices).
2. Make a bundle.json from `dist/` (same shape as above).
3. In `mimiri-client-electron`: `node scripts/unpack-bundle.mjs <bundle.json>`
   (fills `./app`, the embedded base bundle), then
   `npx electron-builder --linux dir` → `dist/linux-unpacked/`.
4. Copy `linux-unpacked` to `artifacts/<ver>/targz/mimiri-notes/`, hand-write
   `meta.json` + drop the bundle.json as `artifacts/<ver>/bundle.json`, and
   run with `MIMIRI_VERSION=<ver>`.

## Clean up staged local builds

After staging a local shell build under `artifacts/<ver>/`, **remove it once
the real `<ver>` publishes** — fetch-artifact sees the executable, treats the
version as already prepared, and silently keeps testing your local build
instead of the released one.
