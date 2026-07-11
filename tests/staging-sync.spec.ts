import { test, expect, Locator, Page } from "@playwright/test";
import crypto from "crypto";
import {
  launchApp,
  cleanup,
  getTestInfo,
  loadMeta,
  supportsUpdateSeams,
  AppContext,
} from "../helpers/app";
import { enterLocalMode, createRootNote } from "../helpers/ui";

/**
 * Staging-sync smoke test: the core product loop — account creation,
 * encryption key handling, server sync — against a real backend, on the
 * published build. Every other spec runs in local mode; this is the only
 * place the shipped client talks to a server.
 *
 * The backend is the dev/staging cluster (override with
 * MIMIRI_STAGING_API_URL). The MIMIRI_API_URL seam (shell ≥ 2.6.9, same
 * vintage as the update seams) points the app at it, and the test asserts
 * the override took effect (mimiriTestInfo.apiUrl) before creating
 * anything, so it can never touch the production backend by accident.
 *
 * Accounts are throwaway: random credentials, deleted through the UI at the
 * end of the flow. A run that dies mid-flow can leave a stray account
 * behind — acceptable on the dev cluster.
 *
 * Proof-of-work runs for real here: the dev-mode bypass is compiled out of
 * published builds, so account creation pays the genuine hashcash (fast at
 * the default 15 bits, but the server may demand more — hence the generous
 * timeout).
 */

/**
 * MIMIRI_USE_DEV_API=1 makes the app use its compiled-in dev API host and
 * dev server key pair (a deliberate toggle between baked-in pairs — the
 * seam accepts no arbitrary key/URL, so it cannot be abused to re-key the
 * client). The dev host baked into current builds:
 */
const STAGING_API_URL =
  process.env.MIMIRI_STAGING_API_URL ?? "https://dev-api.mimiri.io/api";

const stagingEnv = { MIMIRI_USE_DEV_API: "1" };

/**
 * Button testids sit on the <button> itself in newer bundles but on a
 * wrapper div in older ones (e.g. create-button in the 2.6.6 bundle, where
 * the right-aligned button doesn't even overlap the wrapper's center — a
 * plain getByTestId click lands on empty space). Target the button either
 * way.
 */
function buttonByTestId(scope: Page | Locator, testId: string): Locator {
  return scope.locator(
    `button[data-testid="${testId}"], [data-testid="${testId}"] button`,
  );
}

/** Waits for the fresh-boot state: login dialog shown or local session up. */
async function waitForBoot(page: Page): Promise<void> {
  const loginDialog = page.getByTestId("login-dialog");
  const status = page.getByTestId("app-status");
  await expect(async () => {
    expect(
      (await loginDialog.isVisible()) ||
        (await status.inputValue()) === "ready",
    ).toBe(true);
  }).toPass({ timeout: 30_000 });
}

/** Opens the login dialog (unless it is already showing) and submits. */
async function submitLogin(
  page: Page,
  username: string,
  password: string,
): Promise<void> {
  const loginDialog = page.getByTestId("login-dialog");
  if (!(await loginDialog.isVisible())) {
    await page.getByTestId("account-button").click();
    await page.getByTestId("menu-login").click();
    await expect(loginDialog).toBeVisible();
  }
  await loginDialog.getByTestId("username-input").fill(username);
  await loginDialog.getByTestId("password-input").fill(password);
  await buttonByTestId(loginDialog, "login-button").click();
}

/**
 * Expands the control panel branch of the note tree until the target
 * settings node is visible, then opens it. The relevant groups
 * (control-panel → settings-group → settings-account) render collapsed on
 * first sight, each with a `<testid>-closed` expander.
 */
async function openSettingsNode(page: Page, nodeId: string): Promise<void> {
  const target = page.getByTestId(nodeId);
  for (const expander of [
    "node-control-panel-closed",
    "node-settings-group-closed",
    "node-settings-account-closed",
  ]) {
    if (await target.isVisible()) {
      break;
    }
    const toggle = page.getByTestId(expander);
    if (await toggle.isVisible()) {
      await toggle.click();
    }
  }
  await expect(target).toBeVisible();
  await target.click();
}

test.describe("staging sync", () => {
  let ctxA: AppContext | undefined;
  let ctxB: AppContext | undefined;

  test.afterAll(async () => {
    await cleanup(ctxB);
    await cleanup(ctxA);
  });

  test("account, sync and deletion round-trip against staging", async () => {
    test.setTimeout(420_000);
    const meta = loadMeta();
    test.skip(
      !supportsUpdateSeams(meta.version),
      "needs the MIMIRI_API_URL seam (shell ≥ 2.6.9)",
    );

    const suffix = crypto.randomBytes(4).toString("hex");
    const username = `e2e_stage_${suffix}`;
    const password = `Pw!${crypto.randomBytes(9).toString("base64url")}`;
    const noteTitle = `staging-sync-${suffix}`;
    const noteContent = `round trip ${suffix}`;

    await test.step("launch pointed at staging", async () => {
      ctxA = await launchApp({ env: stagingEnv });
      await enterLocalMode(ctxA.page);
      const info = await getTestInfo(ctxA.page);
      // Old shells silently ignore MIMIRI_USE_DEV_API — and would talk to
      // production. Only proceed when the seam confirms the toggle took.
      test.skip(
        info?.useDevApi !== true,
        "shell predates the MIMIRI_USE_DEV_API seam",
      );
    });

    await test.step("create a cloud account", async () => {
      const page = ctxA!.page;
      await page.getByTestId("account-button").click();
      await page.getByTestId("menu-create-account").click();
      const view = page.getByTestId("create-account-view");
      await expect(view).toBeVisible();
      const availability = page
        .waitForResponse((r) => r.url().includes("/user/available"), {
          timeout: 30_000,
        })
        .catch(() => undefined);
      await view.getByTestId("username-input").fill(username);
      // The availability check round-trips to the server and gates submit —
      // and is the network-level proof of where traffic goes before
      // anything is created. The shell seam can be present while the
      // bundle's staging config is not (the dev host/key are baked at
      // build time — shell 2.6.14 shipped with a build .env that lacked
      // them); that is a build-configuration gap, not a product
      // regression, so skip loudly instead of failing.
      const availabilityResponse = await availability;
      test.skip(
        availabilityResponse === undefined,
        "no availability response — dev host unreachable (staging config not baked into this bundle?)",
      );
      test.skip(
        !availabilityResponse!.url().includes(STAGING_API_URL),
        `renderer not pointed at staging (went to ${availabilityResponse!.url()}) — bundle lacks the dev key/host config`,
      );
      await expect(page.getByTestId("username-available")).toBeVisible({
        timeout: 30_000,
      });
      await view.getByTestId("password-input").fill(password);
      await view.getByTestId("repeat-input").fill(password);
      await buttonByTestId(view, "create-button").click();
      // Success switches the system page away from the create view
      // (proof-of-work + server round-trip happen in between).
      await expect(view).not.toBeVisible({ timeout: 180_000 });
      // The account menu now offers logout — the session is a cloud account.
      await page.getByTestId("account-button").click();
      await expect(page.getByTestId("menu-logout")).toBeVisible();
      await page.getByTestId("context-menu-backdrop").click();
      // Promotion copies the local data to the cloud account in the
      // background; let that settle before creating anything new, or the
      // note can land outside the copy and never reach the server.
      const sync = page.getByTestId("sync-status-code");
      await expect(async () => {
        expect(await sync.inputValue()).toBe("idle");
      }).toPass({ timeout: 60_000 });
      await page.waitForTimeout(3_000);
      await expect(sync).toHaveValue("idle");
    });

    await test.step("create a note and let it sync", async () => {
      const page = ctxA!.page;
      await createRootNote(ctxA!, noteTitle);
      const editor = page
        .locator(
          '[data-testid="editor-prosemirror-container"] .ProseMirror, ' +
            '[data-testid="editor-monaco-container"] .monaco-editor',
        )
        .first();
      await editor.click();
      await page.keyboard.type(noteContent);
      // "idle" alone is not proof the note reached the server — before the
      // push starts the status still reads idle, and tearing the app down
      // then loses the note. Arm the wait before saving so the save's own
      // push (not an earlier account-creation sync) is what satisfies it.
      const pushed = page.waitForResponse(
        (r) =>
          (r.url().includes("/sync/push-changes") ||
            r.url().includes("/note/multi")) &&
          r.status() === 200,
        { timeout: 60_000 },
      );
      await page.keyboard.press(
        process.platform === "darwin" ? "Meta+s" : "Control+s",
      );
      await pushed;
      const sync = page.getByTestId("sync-status-code");
      await expect(async () => {
        expect(await sync.inputValue()).toBe("idle");
      }).toPass({ timeout: 60_000 });
      await page.waitForTimeout(2_000);
      await expect(sync).toHaveValue("idle");
      await cleanup(ctxA);
      ctxA = undefined;
    });

    await test.step("log in from a fresh profile and find the note", async () => {
      ctxB = await launchApp({ env: stagingEnv });
      const page = ctxB.page;
      await waitForBoot(page);
      await submitLogin(page, username, password);
      await expect(page.getByTestId("login-dialog")).not.toBeVisible({
        timeout: 60_000,
      });
      await expect(page.getByTestId("app-status")).toHaveValue("ready", {
        timeout: 30_000,
      });
      // The note round-tripped: created in profile A, synced to the server,
      // pulled and decrypted here.
      const note = page
        .getByTestId("note-tree")
        .getByTitle(noteTitle, { exact: true });
      await expect(note).toBeVisible({ timeout: 30_000 });
      await note.click();
      const editor = page
        .locator(
          '[data-testid="editor-prosemirror-container"] .ProseMirror, ' +
            '[data-testid="editor-monaco-container"] .monaco-editor',
        )
        .first();
      await expect(editor).toContainText(noteContent, { timeout: 15_000 });
    });

    await test.step("delete the account", async () => {
      const page = ctxB!.page;
      await openSettingsNode(page, "node-settings-delete");
      await page.getByTestId("delete-account-checkbox").check();
      await page.getByTestId("delete-data-checkbox").check();
      await page.getByTestId("no-recovery-checkbox").check();
      // Also wipe local data, so nothing of the account outlives the run.
      await page.getByTestId("delete-local-checkbox").check();
      await page.getByTestId("delete-account-password-input").fill(password);
      const deleted = page.waitForResponse(
        (r) => r.url().includes("/user/delete"),
        { timeout: 60_000 },
      );
      await buttonByTestId(page, "delete-account-submit-button").click();
      expect((await deleted).status()).toBe(200);
      // After the server call the app logs out and reloads the renderer —
      // which can tear down the CDP target entirely, so this launch is not
      // usable beyond this point.
      await cleanup(ctxB);
      ctxB = undefined;
    });

    await test.step("the account is gone from the server", async () => {
      ctxB = await launchApp({ env: stagingEnv });
      const page = ctxB.page;
      await waitForBoot(page);
      await submitLogin(page, username, password);
      await expect(
        page.getByTestId("login-dialog").getByTestId("login-error"),
      ).toBeVisible({ timeout: 60_000 });
    });
  });
});
