# mimiri-e2e

End-to-end test suite for the Mimiri Electron application, built on
[Playwright](https://playwright.dev/).

Downloads a published build (stable, canary or explicit version) from
`update.mimiri.io`, runs a smoke test against it, and cleans up after itself.
Supported platforms: Windows and Linux.

## Usage

```sh
npm install

# fetch an app build into artifacts/<version>
npm run fetch                # latest stable
npm run fetch:canary         # latest canary
npm run fetch -- 2.6.1       # explicit version

# run the tests against the fetched build
npm test

# remove downloaded builds and test output
npm run clean
```

The tests run against the version recorded in `artifacts/current.json`
(the last one fetched). Override with the `MIMIRI_VERSION` environment
variable if multiple versions are fetched.

Each test run launches the app with an isolated temporary user data
directory, which is deleted again when the run finishes.

## Native file-dialog tests (Linux)

`tests/export-import.spec.ts` exercises the app's export/import features
through **real native file dialogs**. Because the suite attaches to the
published binary over CDP, Electron's `dialog` module cannot be stubbed, so
the dialogs are driven for real: the app is launched with `GTK_USE_PORTAL=1`,
which routes its GTK file choosers over D-Bus to `xdg-desktop-portal`; the
dialog is then rendered by `xdg-desktop-portal-gtk` in a separate process and
driven with `xdotool` (see `helpers/native-dialog.ts`).

This needs an X server, a window manager and the portal stack. On a headless
Linux machine, provision it once and run the suite under the wrapper:

```sh
bash scripts/setup-linux-dialogs.sh          # one-time: apt packages + portal config
bash scripts/run-with-dialogs.sh npm test    # Xvfb + openbox + portals, then the tests
```

The spec skips itself on Windows/macOS and on any Linux machine without
`DISPLAY`/`xdotool`, so plain `npm test` stays green everywhere else. CI runs
the whole suite through `scripts/run-with-dialogs.sh` on the Linux job.
