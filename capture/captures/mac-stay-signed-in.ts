import { spawnSync } from "child_process";
import { Page } from "playwright";
import {
  MacScreenRecorder,
  injectCursor,
  launchDevShell,
  macKeystroke,
  macWindowRect,
  outputs,
  pace,
  parkCursor,
  sleep,
  toGif,
  toMp4,
} from "../lib";

/**
 * macOS: "Stay signed in with Touch ID" (mimiri-client#58/#61,
 * mimiri-client-electron#18). Tick the box on the login dialog (the
 * close-vs-quit hint disappears), log in, quit, relaunch → the Touch ID
 * prompt stands between the app and the notes; confirm → back in without
 * the login dialog. Then once more with Cancel → the password dialog.
 *
 * Biometrics do not exist in VMs, so the host's MIMIRI_FAKE_TOUCH_ID=dialog
 * test seam draws a stand-in prompt. Until a shell with the seam is
 * published this runs against a dev shell: CAPTURE_DEV_ELECTRON=<checkout>
 * (with the client served at the URL the dev shell loads).
 */
export default async function capture(): Promise<{ gif: string; mp4: string }> {
  if (process.platform !== "darwin") {
    throw new Error("mac-stay-signed-in records on macOS only");
  }
  const dir = process.env.CAPTURE_DEV_ELECTRON;
  if (!dir) {
    throw new Error(
      "set CAPTURE_DEV_ELECTRON to a mimiri-client-electron checkout (seam not in a published shell yet)",
    );
  }
  const env = { APP_TEST_MODE: "1", MIMIRI_FAKE_TOUCH_ID: "dialog" };
  const files = outputs("mac-stay-signed-in");
  const recorder = new MacScreenRecorder(files.raw);
  const username = `demo_${Date.now().toString(36)}`;
  const password = "correct-horse-battery-staple";

  // --- setup (not recorded): a password-protected local account, then log
  // out so the login dialog is what the recording starts on
  let app = await launchDevShell(dir, env);
  await waitReady(app.page);
  await createLocalAccount(app.page, username, password);
  await app.page.getByTestId("account-button").click();
  await app.page
    .getByTestId("menu-logout")
    .waitFor({ state: "visible", timeout: 5000 });
  await app.page.getByTestId("menu-logout").click();
  await app.page
    .getByTestId("login-dialog")
    .waitFor({ state: "visible", timeout: 15_000 });
  await injectCursor(app.page);
  await parkCursor(app.page, 420, 330);
  const win = macWindowRect(app.pid);
  const region = { x: win.x - 12, y: win.y - 40, w: win.w + 24, h: win.h + 52 };
  const scale = Number(await app.page.evaluate("window.devicePixelRatio")) || 1;

  try {
    recorder.start(region, scale);
    await pace(1000);

    // --- opt in right on the login dialog, then log in
    const dialog = app.page.getByTestId("login-dialog");
    await dialog.getByTestId("stay-signed-in-login").click();
    await pace(1200); // the close-vs-quit hint goes away
    await dialog.getByTestId("username-input").click();
    await app.page.keyboard.type(username, { delay: 45 });
    await dialog.getByTestId("password-input").click();
    await app.page.keyboard.type(password, { delay: 35 });
    await pace(500);
    await dialog
      .locator(
        'button[data-testid="login-button"], [data-testid="login-button"] button',
      )
      .click();
    await dialog.waitFor({ state: "hidden", timeout: 30_000 });
    await pace(1500);

    // --- quit, relaunch: the (simulated) Touch ID prompt, confirm
    await macKeystroke("q", ["command"]);
    await sleep(1800);
    app = await launchDevShell(dir, env);
    await pace(1500); // the prompt is up during boot
    await macKeystroke("\r"); // "Use Touch ID" is the default button
    await waitReady(app.page);
    await pace(2200);

    // --- again, this time Cancel → the password dialog instead
    await macKeystroke("q", ["command"]);
    await sleep(1800);
    app = await launchDevShell(dir, env);
    await pace(1500);
    await macKeystroke(String.fromCharCode(27)); // Escape = Cancel
    await waitReady(app.page);
    await pace(2200);
    await recorder.stop();
  } catch (err) {
    await recorder.stop().catch(() => undefined);
    throw err;
  } finally {
    await app.close();
    spawnSync("osascript", [
      "-e",
      'tell application "System Events" to delete login item "Mimiri Notes Dev"',
    ]);
  }
  toMp4(files.raw, files.mp4);
  toGif(files.raw, files.gif, { width: 800, fps: 12 });
  return { gif: files.gif, mp4: files.mp4 };
}

async function waitReady(page: Page): Promise<void> {
  const status = page.getByTestId("app-status");
  const login = page.getByTestId("login-dialog");
  for (let i = 0; i < 120; i++) {
    if (
      (await status.inputValue().catch(() => "")) === "ready" ||
      (await login.isVisible().catch(() => false))
    ) {
      return;
    }
    await sleep(500);
  }
  throw new Error("app did not become ready");
}

async function createLocalAccount(
  page: Page,
  username: string,
  password: string,
): Promise<void> {
  if (await page.getByTestId("login-dialog").isVisible()) {
    await page.getByTestId("cancel-button").click();
  }
  await page.getByTestId("account-button").click();
  await page
    .getByTestId("menu-create-account")
    .waitFor({ state: "visible", timeout: 5000 });
  await page.getByTestId("menu-create-account").click();
  const view = page.getByTestId("create-account-view");
  await view.waitFor({ state: "visible" });
  await page.getByTestId("settings-view-local-account").click();
  await view.getByTestId("username-input").fill(username);
  await view.getByTestId("password-input").fill(password);
  await view.getByTestId("repeat-input").fill(password);
  await view
    .locator(
      'button[data-testid="create-button"], [data-testid="create-button"] button',
    )
    .click();
  await view.waitFor({ state: "hidden", timeout: 60_000 });
  await sleep(1500);
}
