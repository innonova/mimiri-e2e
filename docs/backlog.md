# Backlog

Remaining items from the July 2026 fit-for-purpose review of the suite
(the reworked Windows shell update, `win-signing.spec.ts` and the zero-retry
nightly came out of the same review — PR #11). Roughly ordered by value.

## Coverage gaps

- [ ] **Staging-sync smoke test** — the core product loop (account creation,
      encryption key handling, server sync) is never exercised against a
      published build: every spec runs `enterLocalMode`. Needs a test/staging
      backend and a credentials story for CI. The largest remaining
      "works in dev, broken in the shipped build" surface.
- [ ] **Sign the binaries inside the nupkg** *(mimiri-client-electron /
      build pipeline, not this repo)* — only `Setup.exe` carries the
      innonova GmbH Authenticode signature. The app exe,
      `Mimiri Notes_ExecutionStub.exe` and `squirrel.exe` (which becomes the
      installed `Update.exe`) ship unsigned, verified back to 2.5.72. Signing
      them reduces AV/firewall friction for the *installed* app. When fixed,
      extend `tests/win-signing.spec.ts` — a comment there marks the spot.
- [ ] **Confirm `bundle-chain` comes alive** — the scenario self-skips while
      the target shell's embedded base bundle is < 2.6.9. Once a shell ships
      with an embedded bundle ≥ 2.6.9, check the scenario actually runs and
      is green (it has never executed for real).
- [ ] **Decide on downgrade paths** — a user installing an older release over
      newer state is untested. If it's unsupported, say so somewhere
      user-visible and close this; if it's meant to work, it needs a scenario.
- [ ] **appimage upgrade coverage** — upgrade-validation's matrix skips
      appimage (and arm64). The targz external-install spec covers similar
      mechanics, but the single-file-replace path itself is untested. Low
      priority.

## Hardening / flakiness

- [ ] **Watch the zero-retry nightly** — the scheduled run now fails loudly on
      timing races (`MIMIRI_RETRIES=0`). If the 6 s renderer watchdog shows up
      as a recurring culprit, consider a client seam to extend it under
      `APP_TEST_MODE` (at the usual cost of not testing shipped behavior).
- [ ] **Surface retry-passes on PR runs** — Playwright marks passed-on-retry
      tests "flaky" in its report, but nobody sees it unless the run fails.
      A CI annotation (or failing threshold) for flaky counts would stop
      races hiding in the retry cushion on PRs too.
- [ ] **native-dialog-win.ts: UIA patterns instead of SendKeys** — the driver
      already locates the picker via UI Automation; using `ValuePattern` (set
      the path) and `InvokePattern` (press Select) removes the focus- and
      timing-dependence of keystrokes.
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
      16 skipped today, mostly legitimate platform gates). Occasionally eyeball
      the skipped list in CI output for gates that should no longer trigger.
- [ ] **Prettier the docs** — `docs/*.md` doesn't pass `format:check` (CI
      doesn't run it). Either run `npm run format` in a dedicated commit or
      scope prettier to code files.
