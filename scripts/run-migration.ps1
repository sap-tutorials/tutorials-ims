# Single-process migration runner — PowerShell native.
# No MSYS2 translation, no Git Bash job-control issues, no tee pipe drops.
#
# Usage from PowerShell:
#   .\scripts\run-migration.ps1
#   .\scripts\run-migration.ps1 -EntityFilter "taskrecords,completionpaths,..."
#
# Args after -EntityFilter (or via -- ) are passed directly to migrate-from-hana.js.

param(
    [string]$EntityFilter = "",
    [switch]$DryRun,
    [switch]$ListEntities
)

$ErrorActionPreference = "Stop"

# Navigate to project root
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
Set-Location $projectRoot

$lockFile = ".migration-data\migration.pid"
$logDir = ".migration-data"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# --- Safety: refuse to start if another migrator is already running ---
if (Test-Path $lockFile) {
    $oldPid = Get-Content $lockFile -ErrorAction SilentlyContinue
    if ($oldPid -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
        Write-Host "✗ Another migrator (PID $oldPid) is already running." -ForegroundColor Red
        Write-Host "  taskkill /F /PID $oldPid; Remove-Item $lockFile"
        exit 1
    }
    Write-Host "⚠ Stale lock file (PID $oldPid dead) — removing"
    Remove-Item $lockFile -Force
}

# --- Source credentials ---
if (-not $env:IMS_HANA_CREDENTIALS) {
    $credsPath = "C:\Users\$env:USERNAME\AppData\Local\Temp\ims-prod-creds.json"
    if (Test-Path $credsPath) {
        $env:IMS_HANA_CREDENTIALS = Get-Content $credsPath -Raw
        Write-Host "✓ Loaded IMS_HANA_CREDENTIALS from $credsPath"
    } else {
        Write-Host "✗ $credsPath missing" -ForegroundColor Red
        exit 1
    }
}

# --- Target credentials ---
if (-not $env:CAP_HANA_CREDENTIALS) {
    $capPath = "C:\Users\$env:USERNAME\AppData\Local\Temp\cap-hana-creds.json"
    if (Test-Path $capPath) {
        $env:CAP_HANA_CREDENTIALS = Get-Content $capPath -Raw
        Write-Host "✓ Loaded CAP_HANA_CREDENTIALS from $capPath"
    } else {
        Write-Host "✗ $capPath missing — run from Git Bash:" -ForegroundColor Red
        Write-Host '    cf service-key tutorials-hana tutorials-hana-key | sed -n "/{/,/^}/p" | jq ".credentials // ." > /tmp/cap-hana-creds.json'
        exit 1
    }
}

$timestamp = Get-Date -UFormat "%Y-%m-%dT%H%M%SZ"
$log = "$logDir\migration-$timestamp.log"

Write-Host "✓ Logging to $log"
Write-Host ""

# Build migrator args
$migratorArgs = @()
if ($DryRun)         { $migratorArgs += "--dry-run" }
if ($ListEntities)   { $migratorArgs += "--list-entities" }
if ($EntityFilter)   { $migratorArgs += "--entity=$EntityFilter" }

Write-Host "Args: $migratorArgs"
Write-Host ""
Write-Host "Migration running. To watch live progress, open another PowerShell window:"
Write-Host "    Get-Content -Path '$log' -Wait"
Write-Host ""
Write-Host "Migration takes 45-90 min for full TaskRecords pull. KEEP THIS WINDOW OPEN."
Write-Host ""

# --- Write PID and register cleanup ---
$PID | Out-File -FilePath $lockFile -Encoding ASCII

try {
    # Use Start-Process for inherited stdio with proper file redirect
    # but actually we want synchronous execution with stdout/stderr to a file
    # PowerShell's & operator with redirection works fine for this
    $process = Start-Process -FilePath "node" `
        -ArgumentList (@("scripts\migrate-from-hana.js") + $migratorArgs) `
        -NoNewWindow `
        -PassThru `
        -RedirectStandardOutput $log `
        -RedirectStandardError "$log.err"
    
    Write-Host "✓ Migrator launched, PID: $($process.Id)"
    $process.Id | Out-File -FilePath $lockFile -Encoding ASCII
    
    # Wait for completion
    $process.WaitForExit()
    $exitCode = $process.ExitCode
    
    # Merge stderr into log
    if (Test-Path "$log.err") {
        Get-Content "$log.err" | Add-Content $log
        Remove-Item "$log.err"
    }
    
    Write-Host ""
    Write-Host "=== Migration finished — last 30 lines of log ==="
    Get-Content $log | Select-Object -Last 30
    Write-Host ""
    
    if ($exitCode -eq 0) {
        Write-Host "✓ Migration completed successfully (exit 0)" -ForegroundColor Green
    } else {
        Write-Host "✗ Migration exited with code $exitCode — full log: $log" -ForegroundColor Red
    }
    
    exit $exitCode
}
finally {
    if (Test-Path $lockFile) {
        Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
    }
}
