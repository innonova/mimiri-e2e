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

## Native file-dialog tests (Linux, macOS)

`tests/export-import.spec.ts` exercises the app's export/import features
through **real native file dialogs**. Because the suite attaches to the
published binary over CDP, Electron's `dialog` module cannot be stubbed, so
the dialogs are driven for real (`helpers/native-dialog.ts` dispatches to a
per-platform driver):

- **Linux** — the app is launched with `GTK_USE_PORTAL=1`, which routes its
  GTK file choosers over D-Bus to `xdg-desktop-portal`; the dialog is
  rendered by `xdg-desktop-portal-gtk` in a separate process and driven with
  `xdotool`. Needs an X server, a window manager and the portal stack; on a
  headless machine, provision once and run under the wrapper:

  ```sh
  bash scripts/setup-linux-dialogs.sh          # one-time: apt packages + portal config
  bash scripts/run-with-dialogs.sh npm test    # Xvfb + openbox + portals, then the tests
  ```

- **macOS** — the NSOpenPanel sheet is driven through System Events
  (Cmd+Shift+G → path → confirm), and the app's native menu bar is used to
  trigger export/import. The process running the tests needs the
  **Automation (System Events)** and **Accessibility** permissions; over SSH
  that means granting them to `sshd-keygen-wrapper` in System Settings →
  Privacy & Security (macOS prompts on first use).

- **Windows** — the IFileDialog folder picker is an owned window nested under
  the app's main window; it is located via UI Automation
  (`NativeWindowHandle`) and driven with SendKeys (type path → Enter). This
  needs an interactive desktop session. On a normal desktop login (or a CI
  runner that provides one) run the tests directly. Over SSH you land in the
  non-interactive session 0 with no desktop, so delegate to the logged-in
  console session:

  ```powershell
  powershell -ExecutionPolicy Bypass -File scripts\run-in-console.ps1 "npx.cmd playwright test"
  ```

The spec skips itself wherever these prerequisites are missing, so plain
`npm test` stays green everywhere else. In CI the Linux job runs the whole
suite through `scripts/run-with-dialogs.sh`; the GitHub macOS runners allow
the automation, so the dialog tests run there too. Whether the Windows dialog
tests run in CI depends on the runner providing an interactive session — they
self-skip if it does not.
