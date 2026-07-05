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
