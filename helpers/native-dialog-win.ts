import { spawnSync } from "child_process";

/**
 * Drives real native file dialogs (the Win32 IFileDialog folder picker) on
 * Windows via UI Automation + window messages, run through PowerShell.
 *
 * Electron's folder picker is an owned window (class #32770) nested under the
 * app's main window (class Chrome_WidgetWin_1), not a child of the desktop
 * root — so we locate the app window first, then its #32770 child, and read
 * that child's NativeWindowHandle. Reaching it this way avoids walking
 * Electron's (huge, slow) accessibility subtree, which otherwise hangs UIA.
 *
 * Input is driven by handle, not keystrokes: UIA locates the picker's Win32
 * controls (the "Folder:" edit, AutomationId 1152; Select Folder / Cancel,
 * AutomationIds 1 / 2 — the IDOK/IDCANCEL dialog control ids), then
 * WM_SETTEXT sets the path and BM_CLICK presses the button. SendMessage
 * targets the control directly, so nothing depends on focus, foreground
 * state, or keystroke timing. UIA ValuePattern/InvokePattern would be the
 * canonical route, but the picker's raw Win32 controls expose no patterns to
 * the managed UIA client (probed on Windows 11: "Unsupported Pattern"), so
 * window messages it is.
 *
 * A real interactive desktop is still required for the dialog to exist at
 * all; winDialogSupport() probes for one and the spec skips itself without
 * it.
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

/** SendMessage/IsWindow P/Invoke plus the dialog element from CLAUDE_HANDLE. */
const DIALOG_PRELUDE =
  UIA_PRELUDE +
  "Add-Type -MemberDefinition '" +
  '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, string l);' +
  '[DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);' +
  '[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);' +
  "' -Name U -Namespace Win32;" +
  "$h=[IntPtr][int64]$env:CLAUDE_HANDLE;" +
  "$dlg=$AE::FromHandle($h);" +
  "function FindById($id){" +
  "  $c=New-Object Windows.Automation.PropertyCondition($AE::AutomationIdProperty,$id);" +
  "  $e=$dlg.FindFirst('Descendants',$c);" +
  '  if($e -eq $null){throw "dialog control $id not found"}' +
  "  [IntPtr]$e.Current.NativeWindowHandle" +
  "}";

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

/**
 * Sets `dir` in the picker's folder edit (WM_SETTEXT) and presses Select
 * Folder (BM_CLICK). An absolute path is accepted in one click; if the
 * dialog instead navigated (still open), press the button once more to
 * accept the now-current folder.
 */
export async function selectWinDirectory(
  dialog: WinNativeDialog,
  dir: string,
): Promise<void> {
  const script =
    DIALOG_PRELUDE +
    "$edit=FindById '1152';" +
    "$ok=FindById '1';" +
    "[void][Win32.U]::SendMessage($edit,0x000C,[IntPtr]::Zero,[string]$env:CLAUDE_DIR);" +
    "Start-Sleep -Milliseconds 200;" +
    "[void][Win32.U]::SendMessage($ok,0x00F5,[IntPtr]::Zero,[IntPtr]::Zero);" +
    "Start-Sleep -Milliseconds 700;" +
    "if([Win32.U]::IsWindow($h)){" +
    "  $ok2=FindById '1';" +
    "  [void][Win32.U]::SendMessage($ok2,0x00F5,[IntPtr]::Zero,[IntPtr]::Zero);" +
    "  Start-Sleep -Milliseconds 700" +
    "}" +
    'if([Win32.U]::IsWindow($h)){throw "picker still open after accept"}';
  const r = psRun(script, {
    CLAUDE_HANDLE: dialog.handle,
    CLAUDE_DIR: dir,
  });
  if (!r.ok) {
    throw new Error(`failed to drive folder picker: ${r.out}`);
  }
}

/** Dismisses the picker via its Cancel button (BM_CLICK). */
export async function cancelWinDialog(dialog: WinNativeDialog): Promise<void> {
  const script =
    DIALOG_PRELUDE +
    "$cancel=FindById '2';" +
    "[void][Win32.U]::SendMessage($cancel,0x00F5,[IntPtr]::Zero,[IntPtr]::Zero);" +
    "Start-Sleep -Milliseconds 700;" +
    'if([Win32.U]::IsWindow($h)){throw "picker still open after cancel"}';
  const r = psRun(script, { CLAUDE_HANDLE: dialog.handle });
  if (!r.ok) {
    throw new Error(`failed to cancel folder picker: ${r.out}`);
  }
}
