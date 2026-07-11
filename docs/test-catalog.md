# Test catalog

All specs run **serially** (`workers: 1`, `fullyParallel: false`) — the app is a
single-instance desktop process. Global timeout is 60 s, but heavy specs raise
their own (up to 900 s). CI retries twice — except the nightly scheduled run,
which sets `MIMIRI_RETRIES=0` so timing races fail loudly there instead of
hiding as retry-passes. Traces/screenshots/videos are kept on failure.

Most specs share one skeleton: `loadMeta()` → skip if the build lacks the needed
capability → maybe `startUpdateServer` → `launchApp` → `enterLocalMode` → drive
UI by `data-testid` → assert both **in the UI** and **on disk** (bundle config,
install dirs, process lists).

## At a glance

| Spec | Protects against | Platforms | Needs |
| --- | --- | --- | --- |
| [smoke-test](../tests/smoke-test.spec.ts) | dead / mispackaged build | all (+ per-format sandbox checks) | just an artifact |
| [update](../tests/update.spec.ts) | broken in-app **bundle** update UI flow | linux, win, mac | client ≥ 2.6.9, bundle.json |
| [update-first-run](../tests/update-first-run.spec.ts) | fresh install stuck on stale embedded bundle | linux, win, mac | client ≥ 2.6.9 |
| [update-repair](../tests/update-repair.spec.ts) | app bricked by half-written bundle | linux, win, mac | client ≥ 2.6.12 |
| [update-stale-bundle](../tests/update-stale-bundle.spec.ts) | shell update reviving an ancient active bundle | all | client ≥ 2.6.5 |
| [update-store-managed](../tests/update-store-managed.spec.ts) | wrong host-update UI per install source | linux only | client ≥ 2.6.13, bundle ≥ 2.6.7 |
| [update-shell-win](../tests/update-shell-win.spec.ts) | broken Squirrel.Windows shell update | win only | Setup.exe + nupkg fetched (base 2.6.9 for the real-release flow) |
| [update-shell-mac](../tests/update-shell-mac.spec.ts) | broken Squirrel.Mac / ShipIt shell update | mac only | two real signed releases |
| [update-shell-external](../tests/update-shell-external.spec.ts) | website-download install-over losing data/bundle | linux, mac, win (targz) | base 2.6.9 archive |
| [update-shell-pkgmgr](../tests/update-shell-pkgmgr.spec.ts) | flatpak/snap upgrade losing data/bundle | linux (flatpak, snap) | base 2.6.9 package |
| [mac-signing](../tests/mac-signing.spec.ts) | unsigned / un-notarized .app bricking downloads | mac only | fetched .app |
| [win-signing](../tests/win-signing.spec.ts) | unsigned Setup.exe tripping SmartScreen | win only | fetched Setup.exe |
| [export-import](../tests/export-import.spec.ts) | broken real native file dialogs | all (with dialog env) | see [native-dialogs.md](native-dialogs.md) |
| [upgrade-flows](../tests/upgrade-flows.spec.ts) | new release breaking **existing users** | all | `UPGRADE_FLOWS=1`, see [upgrade-flows.md](upgrade-flows.md) |

## Spec details

### smoke-test.spec.ts
Baseline sanity for the fetched artifact: window opens and renders, title and
`navigator.userAgent` report the expected version, the 2.6.5+ test seam agrees,
process stays alive. Format-specific cases confirm flatpak actually runs inside
its sandbox (`flatpak ps`) and snap runs from the `/snap/` mount.

### update.spec.ts
The core in-app **bundle** update, end to end through the UI. The mock serves
the artifact's own published bundle re-versioned to 99.0.0 and re-signed with a
per-run key ([update-testing.md](update-testing.md)). Flow: set update mode to
`manual-strong` *before* arming the mock (prevents a background auto-download),
arm, check → download → restart, then assert the app reports 99.0.0 and
`bundles/config.json` on disk agrees.

### update-first-run.spec.ts
The one spec where the mock is armed **before first launch**: a fresh install
must pull the latest bundle at startup with zero UI interaction
(`checkUpdateInitial`). Reaching a usable UI implies the startup update
completed; the settings page and on-disk config confirm the version.

### update-repair.spec.ts
Pre-seeds a deliberately **broken profile** (active bundle whose `index.html`
references a missing asset, plus a stale `.downloading` dir) and asserts the
2.6.11+ shell boots on its embedded base, sweeps the leftovers, serves 404 (not
`net::ERR_UNEXPECTED`) for missing files, and fully repairs via a normal
re-update.

### update-stale-bundle.spec.ts
Startup reconciliation only, no update server: seeds an ancient (0.1.0) active
bundle and asserts the BundleManager discards it in favor of the shell's
embedded base at boot. Covers the "shell update leapfrogged the last bundle
update" case.

### update-store-managed.spec.ts
Linux host-update **presentation** by install source, using the
`MIMIRI_FAKE_STORE` seam: store installs (flathub/snap-store) must show a
"requires a newer app" notice with **no** download link; direct installs must
show a manual download link with the right per-format filename. Never any
`update-download-button` for host updates.

### update-shell-win.spec.ts
Real Squirrel.Windows shell update between two real releases: installs the
pinned base 2.6.9 via its published `Setup.exe` into
`%LOCALAPPDATA%\mimiri_notes`, serves the fetched artifact's **own real
nupkg** (Squirrel only trusts the RELEASES SHA1, so it serves as-is), drives
check → download → restart, asserts `Update.exe` swapped to the new
`app-<version>`, then relaunches the updated install attached and asserts it
reports the new version and reaches a working UI — so the updated *binary* is
proven, not just the swap. When the fetched artifact *is* the base, it falls
back to a **repacked** nupkg (same binaries, nuspec bumped to 99.0.0) to still
exercise the mechanism. Machine-global; uninstalls afterwards.

### update-shell-mac.spec.ts
Real Squirrel.Mac / ShipIt shell update. macOS **cannot** use the repack trick —
Squirrel.Mac validates code signatures — so it updates between two genuinely
signed releases: pinned base 2.6.9 extracted to a temp dir → the fetched
artifact's own zip. ShipIt swaps the `.app` in place; the test polls the
bundle's Info.plist version and the running process path.

### update-shell-external.spec.ts
The "user downloads a newer build from the website and installs over the
existing one" path (targz only; extract-over on linux/mac, real newer Setup.exe
on win). Seeds a note and bundle-updates to 99.0.0 on the 2.6.9 base first, so
it can assert that after the install-over both the **data** and the **active
bundle** (newer than the new shell's embedded base) survive.

### update-shell-pkgmgr.spec.ts
Same survival contract as the external spec, but the upgrade hop is a local
`flatpak install` / `snap install --dangerous` of the newer package — the
stand-in for a store refresh (store transport itself is out of scope).

### mac-signing.spec.ts
No app launch at all: `codesign --verify --deep --strict`, `spctl --assess`,
and `xcrun stapler validate` against the fetched `.app`. This is the piece the
upgrade harness can't cover (its downloads carry no quarantine xattr) — a
broken signature would brick real browser downloads while everything else
stayed green.

### win-signing.spec.ts
The Windows counterpart of mac-signing, also without launching the app:
`Get-AuthenticodeSignature` on the fetched `Setup.exe` must report a valid,
timestamped signature from `CN=innonova GmbH`. Nothing else in the suite
would notice a broken signature (Squirrel validates only the RELEASES SHA1),
but SmartScreen/Defender treat unsigned installer downloads very differently.
Deliberately limited to `Setup.exe`: the binaries inside the nupkg (app exe,
execution stub, `squirrel.exe`) have always shipped unsigned.

### export-import.spec.ts
Export and import through **real** native file dialogs, per OS, plus a
cancellation-leaves-app-healthy case. On Linux it runs each case in both dialog
delivery modes where the format allows (portal and in-process GTK). See
[native-dialogs.md](native-dialogs.md) for the mechanics and prerequisites.

### upgrade-flows.spec.ts
One test per scenario in the release-validation matrix — real old release →
real new release with user state seeded in between. Opt-in and heavily gated;
it has its own page: [upgrade-flows.md](upgrade-flows.md).
