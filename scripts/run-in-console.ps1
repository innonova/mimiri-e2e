# Runs a command in the interactive console session (session 1) via a
# scheduled task and relays its output/exit code.
#
# Native file-dialog automation (UI Automation + SendKeys) needs a real
# interactive desktop. An OpenSSH session lands in the non-interactive
# session 0 with no desktop, so the export/import tests must be delegated to
# the logged-in console session. On a machine where the tests already run in
# an interactive session (a normal desktop login, or a CI runner that
# provides one) this wrapper is unnecessary — run the tests directly.
#
# Usage (from an SSH/session-0 shell, with a user logged in at the console):
#   powershell -ExecutionPolicy Bypass -File scripts\run-in-console.ps1 "npx.cmd playwright test"
#
# The command runs in <repo>\ (the script's parent dir's parent). node must
# be on PATH inside the console session, or referenced by absolute path.
param(
  [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)]
  [string[]]$Command
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$log  = Join-Path $env:TEMP "mimiri-console-out.log"
$flag = Join-Path $env:TEMP "mimiri-console-exit.flag"
$bat  = Join-Path $env:TEMP "mimiri-console-task.cmd"
$cmd  = ($Command -join " ")
Remove-Item $log, $flag -ErrorAction SilentlyContinue

# A batch file avoids quoting the command through schtasks /tr. `call` is
# required so control returns to write the exit flag after npm/npx exits.
@(
  "@echo off",
  "cd /d `"$repo`"",
  "call $cmd > `"$log`" 2>&1",
  "echo %ERRORLEVEL%> `"$flag`""
) | Set-Content -Encoding ASCII $bat

& schtasks.exe /create /f /tn MimiriConsole /sc ONCE /st 00:00 /ru $env:USERNAME /it /tr "cmd.exe /c `"$bat`"" | Out-Null
& schtasks.exe /run /tn MimiriConsole | Out-Null

$deadline = (Get-Date).AddMinutes(10)
while (-not (Test-Path $flag) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
Start-Sleep -Milliseconds 300
& schtasks.exe /delete /f /tn MimiriConsole | Out-Null

if (Test-Path $log) { Get-Content $log }
if (Test-Path $flag) {
  $code = (Get-Content $flag -Raw).Trim()
  Write-Output "console task exit code: $code"
  exit [int]$code
} else {
  Write-Output "console task did not finish within 10 minutes"
  exit 1
}
