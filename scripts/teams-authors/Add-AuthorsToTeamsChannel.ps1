#Requires -Version 7.0
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$RoleCollection,
    [Parameter(Mandatory)][string]$TeamId,
    [Parameter(Mandatory)][string]$ChannelId,
    [Parameter(Mandatory)][string]$TenantDomain,
    [string]$SubaccountGuid
)

$ErrorActionPreference = 'Stop'
Import-Module "$PSScriptRoot/AuthorsToTeams.psm1" -Force

# --- Session checks -------------------------------------------------
if (-not (Get-MgContext)) {
    Write-Error "Not connected to Microsoft Graph. Run: Connect-MgGraph -Scopes 'ChannelMember.ReadWrite.All'"
    exit 1
}

# --- Fetch role-collection members via BTP CLI ----------------------
$args = @('--format','json','get','security/role-collection', $RoleCollection)
if ($SubaccountGuid) { $args += @('--subaccount', $SubaccountGuid) }
Write-Host "Fetching members of role collection '$RoleCollection'..."
$raw = & btp @args 2>&1
if ($LASTEXITCODE -ne 0 -or $raw -match 'Unknown session|Authorization failed') {
    Write-Error "BTP fetch failed. Run 'btp login' and verify the role collection name.`n$raw"
    exit 1
}
$emails = ConvertFrom-RoleCollectionJson -Json ($raw -join "`n")

# --- Split by tenant ------------------------------------------------
$split = Split-MembersByTenant -Emails $emails -TenantDomain $TenantDomain

# --- Preview --------------------------------------------------------
Write-Host ""
Write-Host "Internal authors to add ($($split.Internal.Count)):" -ForegroundColor Cyan
$split.Internal | ForEach-Object { Write-Host "  $_" }
if ($split.External.Count) {
    Write-Host "Skipped (external / cross-tenant) ($($split.External.Count)):" -ForegroundColor Yellow
    $split.External | ForEach-Object { Write-Host "  $_" }
}
if (-not $split.Internal.Count) { Write-Host "Nothing to add."; exit 0 }

# --- Confirm / WhatIf / Add ----------------------------------------
$whatIf = $WhatIfPreference
if (-not $whatIf) {
    $ans = Read-Host "Add these $($split.Internal.Count) member(s) to the channel? [y/N]"
    if ($ans -notmatch '^(y|yes)$') { Write-Host "Aborted."; exit 0 }
}
$result = Add-MembersToChannel -Emails $split.Internal -TeamId $TeamId -ChannelId $ChannelId -WhatIf:$whatIf

# --- Summary --------------------------------------------------------
Write-Host ""
Write-Host "Summary:" -ForegroundColor Green
Write-Host "  Added:          $($result.Added.Count)"
Write-Host "  Already member: $($result.AlreadyMember.Count)"
Write-Host "  Failed:         $($result.Failed.Count)"
Write-Host "  Skipped (ext):  $($split.External.Count)"
if ($result.Failed.Count) { $result.Failed | ForEach-Object { Write-Host "  FAILED: $_" -ForegroundColor Red }; exit 1 }
exit 0
