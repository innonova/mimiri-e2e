import { spawnSync } from "child_process";

/**
 * Drives real native file dialogs (the Win32 IFileDialog folder picker) on
 * Windows via UI Automation + SendKeys, run through PowerShell.
 *
 * Electron's folder picker is an owned window (class #32770) nested under the
 * app's main window (class Chrome_WidgetWin_1), not a child of the desktop
 * root — so we locate the app window first, then its #32770 child, and read
 * that child's NativeWindowHandle. Reaching it this way avoids walking
 * Electron's (huge, slow) accessibility subtree, which otherwise hangs UIA.
 *
 * The picker is then driven by bringing it foreground and typing the target
 * path + Enter (SendKeys). This requires an interactive desktop session;
 * winDialogSupport() probes for one and the spec skips itself without it.
 */

export interface WinNativeDialog {
  /** NativeWindowHandle of the #32770 dialog, as a decimal string. */
  handle: string;
}

function psRun(
  script: string,
  env: Record<string, string> = {},
  timeoutMs = 30_000,
): { ok: boolean; out: string } {
  const r = spawnSync("powershell", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, ...env },
  });
  return {
    ok: r.status === 0,
    out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim(),
  };
}

const UIA_PRELUDE =
  "Add-Type -AssemblyName UIAutomationClient;" +
  "Add-Type -AssemblyName UIAutomationTypes;" +
  "$AE=[Windows.Automation.AutomationElement];" +
  "$TC=[Windows.Automation.Condition]::TrueCondition;";

/** SendKeys treats these as syntax; escape by wrapping each in braces. */
function escapeSendKeys(s: string): string {
  return s.replace(/[+^%~(){}\[\]]/g, (m) => `{${m}}`);
}

/**
 * True when an interactive desktop with windows is reachable (i.e. UIA can
 * enumerate top-level windows). False in a non-interactive session (e.g. a
 * bare SSH/service session), so the spec skips itself there.
 */
export function winDialogSupport(): boolean {
  if (process.platform !== "win32") {
    return false;
  }
  const r = psRun(
    UIA_PRELUDE +
      "$k=$AE::RootElement.FindAll('Children',$TC);" +
      "if($k.Count -gt 0){Write-Output 'OK'}",
    {},
    20_000,
  );
  return r.ok && r.out.includes("OK");
}

/**
 * Polls for the folder picker owned by the app window and returns its handle.
 * Prefers the app window matching `appPid`, falling back to any Mimiri window.
 */
export async function waitForWinFileDialog(
  appPid: number,
  timeoutMs = 15_000,
): Promise<WinNativeDialog> {
  const iters = Math.ceil(timeoutMs / 250);
  const script =
    UIA_PRELUDE +
    '$dc=New-Object Windows.Automation.PropertyCondition($AE::ClassNameProperty,"#32770");' +
    '$ac=New-Object Windows.Automation.PropertyCondition($AE::ClassNameProperty,"Chrome_WidgetWin_1");' +
    "$dlg=$null;" +
    "for($i=0;$i -lt [int]$env:CLAUDE_ITERS;$i++){" +
    "  $apps=$AE::RootElement.FindAll('Children',$ac);" +
    "  for($a=0;$a -lt $apps.Count;$a++){" +
    "    $app=$apps.Item($a);" +
    "    $d=$app.FindFirst('Children',$dc);" +
    "    if($d -ne $null){$dlg=$d}" +
    "  }" +
    "  if($dlg -ne $null){break}" +
    "  Start-Sleep -Milliseconds 250" +
    "}" +
    'if($dlg -ne $null){Write-Output ("HANDLE=" + [IntPtr]$dlg.Current.NativeWindowHandle)}else{Write-Output "NOTFOUND"}';
  const r = psRun(
    script,
    { CLAUDE_APP_PID: String(appPid), CLAUDE_ITERS: String(iters) },
    timeoutMs + 10_000,
  );
  const m = r.out.match(/HANDLE=(\d+)/);
  if (!m) {
    throw new Error(
      `Windows folder picker not found (${r.out || "no output"})`,
    );
  }
  return { handle: m[1] };
}

const FOREGROUND_PRELUDE =
  "Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h);' -Name W -Namespace Win32;" +
  "Add-Type -AssemblyName System.Windows.Forms;" +
  "$h=[IntPtr][int64]$env:CLAUDE_HANDLE;" +
  "[void][Win32.W]::SetForegroundWindow($h);" +
  "Start-Sleep -Milliseconds 500;";

/** Types `dir` into the picker and confirms (Enter navigates, Enter accepts). */
export async function selectWinDirectory(
  dialog: WinNativeDialog,
  dir: string,
): Promise<void> {
  const script =
    FOREGROUND_PRELUDE +
    "[System.Windows.Forms.SendKeys]::SendWait($env:CLAUDE_KEYS);" +
    "Start-Sleep -Milliseconds 500;" +
    '[System.Windows.Forms.SendKeys]::SendWait("{ENTER}");' +
    "Start-Sleep -Milliseconds 700;" +
    '[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")';
  const r = psRun(script, {
    CLAUDE_HANDLE: dialog.handle,
    CLAUDE_KEYS: escapeSendKeys(dir),
  });
  if (!r.ok) {
    throw new Error(`failed to drive folder picker: ${r.out}`);
  }
}

/** Dismisses the picker with Escape. */
export async function cancelWinDialog(dialog: WinNativeDialog): Promise<void> {
  const script =
    FOREGROUND_PRELUDE + '[System.Windows.Forms.SendKeys]::SendWait("{ESC}")';
  const r = psRun(script, { CLAUDE_HANDLE: dialog.handle });
  if (!r.ok) {
    throw new Error(`failed to cancel folder picker: ${r.out}`);
  }
}
