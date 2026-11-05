<#
.SYNOPSIS
  quiet-run (PowerShell port of scripts/quiet-run.sh): run a noisy command, keep the FULL
  output on disk, print only exit code + matched error/failure lines + the last N lines.

.DESCRIPTION
  Keeps deploy/build/test/log scrollback out of an AI agent's context window. Same contract
  as quiet-run.sh: same env knobs, same match pattern, same log location, and it exits with
  the wrapped command's exit code.

  Usage:
    scripts/quiet-run.ps1 <command> [args...]
    scripts/quiet-run.ps1 npm run build:all
    scripts/quiet-run.ps1 cf deploy mta_archives/foo.mtar -e ../deploy/dev.mtaext -f

  Env knobs:
    QUIET_TAIL=15              lines of trailing output to show (default 15)
    QUIET_MATCH=40             max matched error lines to show  (default 40)
    QUIET_LOG_DIR=.quiet-logs  where full logs are written      (default .quiet-logs)

  Pipes/builtins are not supported in the wrapped command; wrap those in a script first.
#>
$ErrorActionPreference = 'Continue'

if ($args.Count -eq 0) {
  [Console]::Error.WriteLine('quiet-run: no command given')
  [Console]::Error.WriteLine('usage: scripts/quiet-run.ps1 <command> [args...]')
  exit 2
}

$tailLines = if ($env:QUIET_TAIL) { [int]$env:QUIET_TAIL } else { 15 }
$matchLines = if ($env:QUIET_MATCH) { [int]$env:QUIET_MATCH } else { 40 }
$logDir = if ($env:QUIET_LOG_DIR) { $env:QUIET_LOG_DIR } else { '.quiet-logs' }

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$ts = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$log = Join-Path $logDir "run-$ts-$PID.log"

# Keep in sync with quiet-run.sh: generic failures plus this repo's known deploy tells.
$pattern = 'error|fail(ed|ure)?|panic|exception|traceback|cannot|unable to|in cds\.deploy|ASSERT_[A-Z_]+|Minification failed|OOM|out of memory|crash|ENOENT|EISDIR|401|403|404|5[0-9][0-9] '

$cmd = [string]$args[0]
$cmdArgs = @($args | Select-Object -Skip 1)

if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
  "error: command not found: $cmd" | Set-Content -Path $log
  $rc = 127
} else {
  $global:LASTEXITCODE = 0
  try {
    & $cmd @cmdArgs *> $log
    $rc = if ($LASTEXITCODE -ne 0) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }
  } catch {
    "error: $($_.Exception.Message)" | Add-Content -Path $log
    $rc = 1
  }
}

$content = @(Get-Content -Path $log -ErrorAction SilentlyContinue)

Write-Output "=== quiet-run: exit=$rc  cmd: $($args -join ' ') ==="
Write-Output "--- matched error/failure lines (max $matchLines) ---"
$hits = @($content | Select-String -Pattern $pattern | Select-Object -First $matchLines)
if ($hits.Count -eq 0) {
  Write-Output '(none matched)'
} else {
  $hits | ForEach-Object { "$($_.LineNumber):$($_.Line)" }
}
Write-Output "--- last $tailLines lines ---"
$content | Select-Object -Last $tailLines
Write-Output "=== full log: $log  ($($content.Count) lines) ==="

exit $rc
