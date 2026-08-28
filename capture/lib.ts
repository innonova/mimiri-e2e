import { spawn, spawnSync, ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import { Page } from "playwright";

/**
 * Helpers for recording short feature demos for pull requests (see
 * docs/running-and-ci.md#pr-media). PR-review audience: a GIF that shows the
 * interaction at human pace, with a cursor, nothing more.
 */

export const OUT_DIR = path.resolve("capture", "out");

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Human-pace pause between demo steps. */
export const pace = (ms = 700) => sleep(ms);

/**
 * Draws a cursor in the page that follows real pointer movement, so
 * Playwright/CDP-driven clicks are visible in a recording (neither a
 * screencast of the renderer nor a Playwright video shows the OS cursor;
 * a macOS full-screen capture does, but the app window itself doesn't
 * receive an OS cursor for synthetic pointer events either).
 */
// Plain JS string: tsx/esbuild would otherwise inject a `__name` helper into
// the serialized function that does not exist inside the page.
const CURSOR_SCRIPT = `(() => {
  if (document.getElementById("__demo-cursor")) return;
  const el = document.createElement("div");
  el.id = "__demo-cursor";
  const svgNs = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("width", "22");
  svg.setAttribute("height", "30");
  svg.setAttribute("viewBox", "0 0 22 30");
  const p = document.createElementNS(svgNs, "path");
  p.setAttribute("d", "M2 2 L2 24 L8 18 L12 28 L16 26 L12 17 L20 17 Z");
  p.setAttribute("fill", "#111");
  p.setAttribute("stroke", "#fff");
  p.setAttribute("stroke-width", "1.5");
  p.setAttribute("stroke-linejoin", "round");
  svg.appendChild(p);
  el.appendChild(svg);
  Object.assign(el.style, {
    position: "fixed", left: "-100px", top: "-100px", zIndex: "2147483647",
    pointerEvents: "none", transition: "left 60ms linear, top 60ms linear",
  });
  // A manual popover lives in the top layer, above modal <dialog>s and their
  // backdrops (which would otherwise hide the cursor); re-show it whenever
  // the set of open dialogs changes so it stays topmost.
  el.setAttribute("popover", "manual");
  Object.assign(el.style, { margin: "0", padding: "0", border: "0", background: "transparent", overflow: "visible", inset: "auto" });
  document.documentElement.appendChild(el);
  let dialogs = -1;
  const raise = () => {
    const n = document.querySelectorAll("dialog[open]").length;
    if (n !== dialogs) {
      dialogs = n;
      try { el.hidePopover(); } catch (e) {}
      try { el.showPopover(); } catch (e) {}
    }
  };
  raise();
  document.addEventListener("mousemove", (e) => {
    raise();
    el.style.left = e.clientX + "px";
    el.style.top = e.clientY + "px";
  }, true);
  document.addEventListener("mousedown", () => { el.style.transform = "scale(0.85)"; }, true);
  document.addEventListener("mouseup", () => { el.style.transform = ""; }, true);
})()`;

export async function injectCursor(page: Page): Promise<void> {
  await page.evaluate(CURSOR_SCRIPT);
}

/** Moves the demo cursor somewhere sensible before the first step. */
export async function parkCursor(
  page: Page,
  x: number,
  y: number,
): Promise<void> {
  await page.mouse.move(x, y, { steps: 12 });
}

function osa(script: string): { ok: boolean; out: string } {
  const r = spawnSync("osascript", ["-e", script], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
}

const procRef = (pid: number) =>
  `(first application process whose unix id is ${pid})`;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Moves the app's main window (points), e.g. to the top-left so a crop can hold both the menu bar titles and the window. */
export function macMoveWindow(pid: number, x: number, y: number): void {
  const r = osa(
    `tell application "System Events" to tell ${procRef(pid)} to set position of window 1 to {${x}, ${y}}`,
  );
  if (!r.ok) {
    throw new Error(`could not move window: ${r.out}`);
  }
}

/** Screen rectangle of the app's main window (points), via accessibility. */
export function macWindowRect(pid: number): Rect {
  const r = osa(
    `tell application "System Events" to tell ${procRef(pid)} to get {position, size} of window 1`,
  );
  if (!r.ok) {
    throw new Error(`could not read window rect: ${r.out}`);
  }
  const [x, y, w, h] = r.out.split(",").map((n) => Number(n.trim()));
  return { x, y, w, h };
}

/**
 * Opens a menu of the app's native menu bar so it is visible on screen
 * (System Events' `click menu item` performs the action without showing the
 * menu — fine for tests, invisible in a recording).
 */
export async function macShowMenu(pid: number, menu: string): Promise<void> {
  osa(
    `tell application "System Events" to set frontmost of ${procRef(pid)} to true`,
  );
  const r = osa(
    `tell application "System Events" to tell ${procRef(pid)} to click menu bar item "${menu}" of menu bar 1`,
  );
  if (!r.ok) {
    throw new Error(`could not open menu ${menu}: ${r.out}`);
  }
}

/** Clicks an item of a menu opened with macShowMenu. */
export async function macClickShownMenuItem(
  pid: number,
  menu: string,
  item: string,
): Promise<void> {
  const r = osa(
    `tell application "System Events" to tell ${procRef(pid)} to click menu item "${item}" of menu "${menu}" of menu bar item "${menu}" of menu bar 1`,
  );
  if (!r.ok) {
    throw new Error(`could not click ${menu} > ${item}: ${r.out}`);
  }
}

export async function macKeystroke(
  key: string,
  modifiers: string[] = [],
): Promise<void> {
  const using = modifiers.length
    ? ` using {${modifiers.map((m) => `${m} down`).join(", ")}}`
    : "";
  osa(`tell application "System Events" to keystroke "${key}"${using}`);
}

const FFMPEG =
  process.platform === "darwin" ? "/opt/homebrew/bin/ffmpeg" : "ffmpeg";

/**
 * macOS screen recording through ffmpeg's avfoundation input — the only
 * capture that includes native menus, sheets, system prompts and the real
 * cursor. Stops cleanly on "q" via stdin (unlike `screencapture -v`, which
 * needs a TTY). Needs the Screen Recording grant for the SSH session.
 * Regions are in points; pass the display scale (devicePixelRatio) so the
 * crop lands on the right pixels on Retina displays.
 */
export class MacScreenRecorder {
  private child?: ChildProcess;
  constructor(private readonly file: string) {}

  start(region?: Rect, scale = 1): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.rmSync(this.file, { force: true });
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "avfoundation",
      "-framerate",
      "30",
      "-capture_cursor",
      "1",
      "-pixel_format",
      "bgr0",
      "-i",
      "Capture screen 0:none",
    ];
    if (region) {
      const r = (n: number) => Math.round(n * scale);
      args.push(
        "-vf",
        `crop=${r(region.w)}:${r(region.h)}:${r(region.x)}:${r(region.y)}`,
      );
    }
    args.push(
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      this.file,
    );
    this.child = spawn(FFMPEG, args, { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    this.child.stderr?.on("data", (d) => (err += d.toString()));
    this.child.on("exit", (code) => {
      if (code !== 0 && code !== null && !fs.existsSync(this.file)) {
        console.error(`ffmpeg screen capture exited ${code}: ${err}`);
      }
    });
  }

  /** Stops the recording and waits for ffmpeg to finalise the file. */
  async stop(): Promise<string> {
    if (!this.child) {
      throw new Error("recorder not started");
    }
    const child = this.child;
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null) {
        resolve();
      } else {
        child.on("exit", () => resolve());
      }
    });
    child.stdin?.write("q");
    await Promise.race([exited, sleep(15_000)]);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
    if (!fs.existsSync(this.file)) {
      throw new Error(`screen capture produced no file at ${this.file}`);
    }
    return this.file;
  }
}

process.platform === "darwin" ? "/opt/homebrew/bin/ffmpeg" : "ffmpeg";

/**
 * Encodes a recording as a palette-optimised GIF for a PR body (renders
 * inline on GitHub; keep it short — ~5 MB is the practical ceiling).
 */
export function toGif(
  input: string,
  output: string,
  opts: {
    width?: number;
    fps?: number;
    trimStart?: number;
    trimEnd?: number;
  } = {},
): string {
  const { width = 800, fps = 12, trimStart = 0, trimEnd } = opts;
  const filters = `fps=${fps},scale=${width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5`;
  const args = ["-y", "-loglevel", "error"];
  if (trimStart) {
    args.push("-ss", String(trimStart));
  }
  args.push("-i", input);
  if (trimEnd !== undefined) {
    args.push("-to", String(trimEnd - trimStart));
  }
  args.push("-vf", filters, output);
  const r = spawnSync(FFMPEG, args, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`ffmpeg gif failed: ${r.stderr}`);
  }
  return output;
}

/** H.264 MP4 companion (linked from the PR, not inlined). */
export function toMp4(
  input: string,
  output: string,
  opts: { width?: number } = {},
): string {
  const { width = 1280 } = opts;
  const r = spawnSync(
    FFMPEG,
    [
      "-y",
      "-loglevel",
      "error",
      "-i",
      input,
      "-vf",
      `scale='min(${width},iw)':-2`,
      "-c:v",
      "libx264",
      "-crf",
      "26",
      "-preset",
      "slow",
      "-pix_fmt",
      "yuv420p",
      "-an",
      output,
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    throw new Error(`ffmpeg mp4 failed: ${r.stderr}`);
  }
  return output;
}

export function outputs(name: string): {
  raw: string;
  mp4: string;
  gif: string;
} {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  return {
    raw: path.join(OUT_DIR, `${name}.raw.mp4`),
    mp4: path.join(OUT_DIR, `${name}.mp4`),
    gif: path.join(OUT_DIR, `${name}.gif`),
  };
}
