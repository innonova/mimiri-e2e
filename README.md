# mimiri-e2e

End-to-end test suite for the Mimiri Electron application, built on
[Playwright](https://playwright.dev/).

## Prerequisites

- Node.js 20+
- A packaged build of the app placed under `artifacts/<version>/`
  (use `npm run fetch` to prepare it — currently a scaffold).

## Setup

```bash
npm install
cp .env.example .env
```

## Fetching the app artifact

```bash
npm run fetch            # fetches the "current" version
npm run fetch -- v1.2.3  # fetches a specific version
```

The suite expects the executable at the platform-specific path defined in
[helpers/app.ts](helpers/app.ts).

## Running tests

```bash
npm test                 # run the full suite
npm run test:headed      # run with a visible window
npm run test:ui          # open the Playwright UI runner
npm run report           # open the last HTML report
```

## Project structure

```
helpers/       Shared test helpers (app launch, etc.)
scripts/       Tooling scripts (artifact fetching, etc.)
tests/         Playwright *.spec.ts test files
artifacts/     Packaged app builds (git-ignored)
```

## Type checking & formatting

```bash
npm run typecheck        # tsc --noEmit
npm run format           # prettier --write
npm run format:check     # prettier --check
```
