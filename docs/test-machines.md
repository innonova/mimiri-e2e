# Test machines: what any macOS / Windows box needs

Portable facts about driving the published desktop app on a machine you reach
over SSH. Which machines exist, their addresses and credentials are
deliberately **not** here — they are specific to one developer box and live in
that box's user-level `~/.claude/CLAUDE.md` (Claude) or your own notes.

## macOS

### Permissions (TCC)

System Events automation (menus, sheets, keystrokes) and Accessibility are
governed by TCC. Over SSH the requesting process is `sshd-keygen-wrapper`, so
grants must be made for that binary; `macDialogSupport()` probes for them by
sending an empty keystroke. Screen Recording (`screencapture`) is a third,
separate grant — CDP `Page.captureScreenshot` avoids needing it for page-level
screenshots.

On a stock Mac these grants require clicking through dialogs on the desktop.
On a machine with **SIP disabled** (the cirruslabs Tart images used for
disposable VMs) the TCC database is directly writable and the grants can be
inserted with `sqlite3` — the intended way to provision a throwaway VM.

### Keychain

- Electron's `safeStorage` (used by the client's "stay signed in" store) keeps
  its key in the user's **login keychain** under `"<app name> Safe Storage"`.
- Over SSH the login keychain counts as **locked for that audit session**
  until `security unlock-keychain` runs in the same session that launches the
  app; otherwise `safeStorage.isEncryptionAvailable()` is false and the app
  logs `errSecInteractionNotAllowed (-25308)`. Published builds that never
  touch safeStorage at boot are unaffected, which is why the suite runs fine
  without it.
- The item's ACL is per **signing identity**: every signed release opens the
  same item without a prompt, but an unsigned dev Electron cannot — give a dev
  build its own `app.setName()` so it creates a separate item.
- A fake `$HOME` does not move the keychain (securityd resolves it per user),
  which is why macOS real-profile flows wipe the `"Mimiri Notes Key"` item
  instead of isolating it (see [architecture.md](architecture.md)).

### Biometrics

Virtual machines on Apple's Virtualization framework (`VirtualMac2,1`) have
**no biometric sensor**: `LocalAuthentication` reports biometry unavailable,
`canPromptTouchID()` is false, and features gated on Touch ID hide themselves.
Nothing in TCC or elsewhere changes that. The real prompt can only be seen on
physical hardware with Touch ID, and its success path needs a finger — treat it
as a manual check, and cover the surrounding flow through a test-mode seam
instead.

### Process identity

`osascript … tell process "<name>"` and `first process whose unix id is <pid>`
are only unambiguous for **bundled, signed** builds (own bundle id). Two
un-bundled dev Electrons share `com.github.Electron` and cannot be told apart;
a leftover published build from an earlier run (they register themselves as
login items via the app's "open at login" setting) will be what a by-name
target resolves to. Check `pgrep -fl mimiri-notes` before trusting a dump.

## Windows

SSH lands in **session 0**, which has no interactive desktop: UI Automation
sees zero windows there. Anything that drives dialogs must be delegated to
the logged-in console session (`scripts/run-in-console.ps1`, schtasks-based).
Env-based profile isolation does not work (Electron resolves paths through
Win32 APIs that ignore `USERPROFILE`/`APPDATA` overrides) — real-profile mode
only, on disposable machines.

## Linux

Headless boxes need Xvfb + a window manager + a private D-Bus session with the
portals for dialog tests (`scripts/run-with-dialogs.sh`,
`scripts/setup-linux-dialogs.sh`), and the Electron sandbox needs
`kernel.apparmor_restrict_unprivileged_userns=0` (not persistent across
reboots). Details in [native-dialogs.md](native-dialogs.md).
