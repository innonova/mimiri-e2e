import { spawnSync } from "child_process";
import { launchApp, cleanup } from "../../helpers/app";
import { enterLocalMode } from "../../helpers/ui";
import { clickNativeMenuItem } from "../../helpers/native-dialog-mac";
import {
  MacScreenRecorder,
  injectCursor,
  macClickShownMenuItem,
  macKeystroke,
  macMoveWindow,
  macShowMenu,
  macWindowRect,
  outputs,
  pace,
  parkCursor,
  toGif,
  toMp4,
} from "../lib";

/**
 * macOS: pasting into the login password field through the native Edit menu
 * and with Cmd+V (mimiri-client#55 / mimiri-client-electron#17). Records the
 * screen region covering the menu bar and the app window so the native menu
 * is visible.
 */
export default async function capture(): Promise<{ gif: string; mp4: string }> {
  if (process.platform !== "darwin") {
    throw new Error("mac-login-paste records on macOS only");
  }
  const files = outputs("mac-login-paste");
  const ctx = await launchApp();
  const pid = ctx.process.pid!;
  const recorder = new MacScreenRecorder(files.raw);
  try {
    const { page } = ctx;
    await enterLocalMode(page);
    await injectCursor(page);
    await parkCursor(page, 400, 300);

    // Park the window at the top-left so one crop holds the menu bar titles
    // (far left) and the whole window.
    macMoveWindow(pid, 0, 25);
    await pace(400);
    const win = macWindowRect(pid);
    const scale = await page.evaluate("window.devicePixelRatio");
    recorder.start(
      { x: 0, y: 0, w: win.x + win.w + 12, h: win.y + win.h + 12 },
      Number(scale) || 1,
    );
    await pace(800);

    await clickNativeMenuItem(pid, "Mimiri Notes", "Log In / Switch User");
    await page.getByTestId("login-dialog").waitFor({ state: "visible" });
    await pace(900);

    const password = page.getByTestId("password-input");
    await password.click();
    await pace(600);

    spawnSync("pbcopy", { input: "correct-horse-battery-staple" });
    await macShowMenu(pid, "Edit");
    await pace(1100);
    await macClickShownMenuItem(pid, "Edit", "Paste");
    await pace(1400);

    // ...and the shortcut path, after clearing the field.
    await macKeystroke("a", ["command"]);
    await macKeystroke(String.fromCharCode(8)); // delete
    await pace(500);
    await macKeystroke("v", ["command"]);
    await pace(1500);
  } catch (err) {
    await recorder.stop().catch(() => undefined);
    await cleanup(ctx);
    throw err;
  }
  await recorder.stop();
  await cleanup(ctx);
  toMp4(files.raw, files.mp4);
  toGif(files.raw, files.gif, { width: 800, fps: 12 });
  return { gif: files.gif, mp4: files.mp4 };
}
