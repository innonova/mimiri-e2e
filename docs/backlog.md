# Backlog

Remaining items from the July 2026 fit-for-purpose review of the suite
(the reworked Windows shell update, `win-signing.spec.ts` and the zero-retry
nightly came out of the same review — PR #11). Roughly ordered by value.

## Coverage gaps

- [x] **Staging-sync smoke test** — done: `tests/staging-sync.spec.ts` runs
      the full loop (account creation with real PoW, sync, fresh-profile
      round-trip, account deletion) against dev-api. No credentials story
      needed — accounts are random per run and deleted through the UI.
      Requires the `MIMIRI_USE_DEV_API` shell seam (client PR #46 /
      electron PR #15), shipped in shell 2.6.14 — but the seam also needs
      the **dev host/key baked into the bundle at build time**, and the
      release build's `.env` doesn't have them yet: 2.6.14's bundle bakes
      `VITE_MIMER_DEV_API_HOST=https://app-dev-aek.mimiri.io` (stale) and
      no `VITE_DEV_API_PUBLIC_KEY(_ID)` at all. The spec skips with an
      explanatory reason until a bundle ships with
      `VITE_MIMER_DEV_API_HOST=https://dev-api.mimiri.io/api` +
      `VITE_DEV_API_PUBLIC_KEY(_ID)` (values in `.env.example`) in the
      build environment — watch for the skip disappearing in the CI
      summary.
- [ ] **Sign the binaries inside the nupkg** _(mimiri-client-electron /
      build pipeline, not this repo)_ — only `Setup.exe` carries the
      innonova GmbH Authenticode signature. The app exe,
      `Mimiri Notes_ExecutionStub.exe` and `squirrel.exe` (which becomes the
      installed `Update.exe`) ship unsigned, verified back to 2.5.72. Signing
      them reduces AV/firewall friction for the _installed_ app. When fixed,
      extend `tests/win-signing.spec.ts` — a comment there marks the spot.
      How signing works today: on the build server, a **manual** signtool
      step that prompts for the PIN of a hardware signing key — which is why
      no signing appears in the repo. The canonical fix is `signWithParams`
      on maker-squirrel (electron-winstaller then signs every PE before
      packing); with the hardware token that means one PIN prompt per file
      during `npm run make` unless the token's PIN caching is enabled. It
      must run **before** `rename-packages.mjs` computes the update-manifest
      signature over the final nupkg bytes.
- [ ] **Confirm `bundle-chain` comes alive** — the scenario self-skips while
      the target shell's embedded base bundle is < 2.6.9. The base bundle
      version is only observable at runtime, so the smoke test annotates it
      and the CI step summary now shows it ("Embedded base bundle: x.y.z").
      Once that line reads ≥ 2.6.9, check the scenario actually runs and is
      green (it has never executed for real).
- [ ] **Decide on downgrade paths** — a user installing an older release over
      newer state is untested. Product stance (July 2026): usually works,
      but there are cutoffs — a newer version can create items an older one
      doesn't understand, and how to handle that has not been designed.
      Needs that product decision (which versions must tolerate which data)
      before a test scenario makes sense; parked until then.
- [ ] **appimage upgrade coverage** — upgrade-validation's matrix skips
      appimage (and arm64). The targz external-install spec covers similar
      mechanics, but the single-file-replace path itself is untested. Low
      priority.

## Hardening / flakiness

- [ ] **Watch the zero-retry nightly** — the scheduled run now fails loudly on
      timing races (`MIMIRI_RETRIES=0`). If the 6 s renderer watchdog shows up
      as a recurring culprit, consider a client seam to extend it under
      `APP_TEST_MODE` (at the usual cost of not testing shipped behavior).
- [x] **Surface retry-passes on PR runs** — done: a JSON reporter feeds
      `scripts/report-summary.ts`, which lists flaky tests in the CI step
      summary and emits `::warning::` annotations on every run. Revisit a
      failing threshold if warnings get ignored.
- [x] **native-dialog-win.ts: UIA patterns instead of SendKeys** — done, with
      a twist: the picker's raw Win32 controls expose no UIA patterns (probed
      on Win11 — "Unsupported Pattern"), so the driver uses UIA to locate the
      control handles and `WM_SETTEXT`/`BM_CLICK` to drive them. Same win:
      no focus, foreground, or keystroke-timing dependence.
- [ ] **native-dialog-linux.ts: AT-SPI escape hatch** — the sidebar bookmark
      is clicked at a fixed pixel offset, stable only because Xvfb geometry
      and portal-gtk are pinned. If an Ubuntu portal-gtk update moves the
      sidebar, the fix is AT-SPI (target the bookmark row semantically).
      Don't build it preemptively.

## Recurring upkeep

- [ ] **`SHELL_UPGRADE_BASE_VERSION` (2.6.9, helpers/app.ts)** — move forward
      if old artifacts are ever pruned from the update host; every
      shell-upgrade/external-install spec anchors on it.
- [ ] **`ANCIENT_WILD_VERSIONS` (2.5.72, 2.6.1, helpers/upgrade-flows.ts)** —
      update as the install population moves (telemetry).
- [ ] **Watch skip counts** — specs degrade gracefully by self-skipping, which
      is also how coverage quietly evaporates (a Windows run reports
      16 skipped today, mostly legitimate platform gates). The CI step summary
      now lists every skipped test with its reason — occasionally eyeball it
      for gates that should no longer trigger.
- [x] **Prettier the docs** — done: `docs/*.md` formatted in a dedicated
      commit and `format:check` now runs as a CI job in `e2e.yml`.
