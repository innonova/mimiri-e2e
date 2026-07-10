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

# Linux only: pick a specific package format from the update feed
npm run fetch -- canary --format=flatpak    # targz (default) | flatpak | appimage | snap

# run the tests against the fetched build
npm test

# remove downloaded builds and test output
npm run clean
```

The tests run against the version and format recorded in
`artifacts/current.json` (the last one fetched). Override with the
`MIMIRI_VERSION` / `APP_FORMAT` environment variables if multiple
artifacts are fetched.

## Linux package formats

The update feed ships Linux builds as tar.gz, flatpak, AppImage and snap;
the suite can test all four:

- **targz** — extracted under `artifacts/<version>/targz/` and executed in
  place. The default everywhere.
- **flatpak** — the single-file bundle is installed into the _user_ flatpak
  installation (`flatpak install --user`); the runtime is resolved from
  flathub, so the flathub remote must exist
  (`scripts/setup-linux-dialogs.sh flatpak` sets both up). Only one version
  can be installed at a time — fetch re-installs on version switches. The
  app is launched with `flatpak run` (env passed as `--env=` flags, the temp
  user-data dir granted via a per-run `--filesystem=` override) and torn
  down with `flatpak kill io.mimiri.notes`. The flatpak sandbox has **no
  filesystem grants**, so the export/import tests exercise the real
  FileChooser + document portal path.
- **appimage** — the `.AppImage` file is made executable and run directly,
  which requires FUSE (`libfuse2`/`libfuse2t64`;
  `scripts/setup-linux-dialogs.sh appimage` installs it).
- **snap** — installed system-wide with `sudo snap install --dangerous`
  (local file, no store assertions; the standard desktop interfaces still
  auto-connect) and launched with `snap run`. Strict confinement means a
  private `/tmp` and no dotfile access in `$HOME`, so the temp user-data
  dir is created as a non-hidden directory under `$HOME` instead. The
  export/import target dirs can stay in `/tmp` — the app only reaches them
  through the document portal, same as flatpak. Unlike the other formats,
  the dialog tests run on the **real** user session bus rather than a
  private one (`run-with-dialogs.sh` switches automatically): a confined
  snap cannot reach a private bus socket, and `snap run` needs the user
  systemd on the bus to create its tracking scope.

All formats are built for amd64 and arm64; the fetch script picks the
artifact matching the host architecture. In CI the Linux job runs once per
format on both amd64 (`ubuntu-latest`) and arm64 (`ubuntu-24.04-arm`)
runners (see the matrix in `.github/workflows/e2e.yml`).

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
`npm test` stays green everywhere else. In CI the dialog tests run on all
three platforms: the Linux job wraps the suite in
`scripts/run-with-dialogs.sh`, and the GitHub macOS and Windows runners both
provide interactive sessions that allow the automation.
