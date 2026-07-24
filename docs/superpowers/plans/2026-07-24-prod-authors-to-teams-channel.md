# Add PROD Authors to Teams Shared Channel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single PowerShell script that reads the members of a PROD BTP role collection and adds them to a Microsoft Teams shared channel, with preview/confirm and dry-run safety.

**Architecture:** Testable pure functions live in a module (`AuthorsToTeams.psm1`): JSON parsing, tenant split, and the add-loop are unit-tested with Pester 5 using mocks for `btp` and `New-MgTeamChannelMember`. A thin orchestrator script (`Add-AuthorsToTeamsChannel.ps1`) wires session checks → fetch → preview → confirm/WhatIf → add → summary.

**Tech Stack:** PowerShell 7 (`pwsh`), BTP CLI (`btp`), Microsoft.Graph.Teams module, Pester 5 for tests.

## Global Constraints

- Cmdlet for adding a channel member is `New-MgTeamChannelMember` — never `Add-MgTeamChannelAllMember`.
- Graph scope required: `ChannelMember.ReadWrite.All` (not `Group.ReadWrite.All`).
- Shared-channel members are added directly; do not rely on team-membership inheritance.
- All authors assumed in-tenant (same email in BTP and Entra). Emails whose domain ≠ tenant domain are reported as **skipped-external**, never added.
- No secrets in source. Auth comes from existing `btp login` and `Connect-MgGraph` sessions.
- Re-runs must be idempotent: existing members are logged as "already a member," never fatal.
- Script params: `-RoleCollection`, `-SubaccountGuid` (default = current BTP target), `-TeamId`, `-ChannelId`, `-WhatIf`.
- Files live in the `d:\projects\cloud-cap-hana-swapi` repo under `scripts/` and `tests/`; the `docs/superpowers` tree is force-added (gitignored).

---

## File Structure

- Create: `scripts/AuthorsToTeams.psm1` — pure/testable functions.
- Create: `scripts/Add-AuthorsToTeamsChannel.ps1` — orchestrator/entry point.
- Create: `tests/AuthorsToTeams.Tests.ps1` — Pester 5 unit tests.
- Create: `tests/fixtures/role-collection.json` — captured `btp` JSON sample.

---

### Task 1: Bootstrap tooling

**Files:**
- Create: `scripts/` and `tests/fixtures/` directories (implicitly via file writes).

**Interfaces:**
- Produces: Pester 5.x and `Microsoft.Graph.Teams` available for later tasks.

- [ ] **Step 1: Install Pester 5 and the Graph Teams module (CurrentUser scope)**

Run:
```bash
pwsh -NoProfile -Command "Install-Module Pester -MinimumVersion 5.0.0 -Scope CurrentUser -Force -SkipPublisherCheck; Install-Module Microsoft.Graph.Teams -Scope CurrentUser -Force"
```
Expected: completes without error.

- [ ] **Step 2: Verify versions**

Run:
```bash
pwsh -NoProfile -Command "(Get-Module -ListAvailable Pester | Sort-Object Version -Descending | Select-Object -First 1).Version.ToString(); if (Get-Module -ListAvailable Microsoft.Graph.Teams) {'graph-teams: yes'} else {'graph-teams: no'}"
```
Expected: a version `5.x.x` printed, then `graph-teams: yes`.

- [ ] **Step 3: Commit** (nothing to commit yet — modules are user-scoped; skip if `git status` is clean)

---

### Task 2: Parse role-collection JSON into emails

**Files:**
- Create: `tests/fixtures/role-collection.json`
- Create: `scripts/AuthorsToTeams.psm1`
- Test: `tests/AuthorsToTeams.Tests.ps1`

**Interfaces:**
- Produces: `ConvertFrom-RoleCollectionJson -Json <string>` → `[string[]]` of deduped, lowercased user emails. Tolerates both `userReferences` and `users` array shapes; reads `email` and falls back to `userName` when `email` is absent.

- [ ] **Step 1: Create the fixture**

Create `tests/fixtures/role-collection.json`:
```json
{
  "name": "SWAPI_Author",
  "roleReferences": [
    { "roleTemplateName": "Author", "name": "Author" }
  ],
  "userReferences": [
    { "userName": "alice@contoso.com", "email": "alice@contoso.com", "origin": "sap.ids" },
    { "userName": "bob@contoso.com",   "email": "Bob@contoso.com",   "origin": "sap.ids" },
    { "userName": "carol@partner.io",  "email": "carol@partner.io",  "origin": "sap.ids" },
    { "userName": "alice@contoso.com", "email": "alice@contoso.com", "origin": "sap.ids" }
  ]
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/AuthorsToTeams.Tests.ps1`:
```powershell
BeforeAll {
    Import-Module "$PSScriptRoot/../scripts/AuthorsToTeams.psm1" -Force
    $script:fixture = Get-Content "$PSScriptRoot/fixtures/role-collection.json" -Raw
}

Describe 'ConvertFrom-RoleCollectionJson' {
    It 'extracts deduped, lowercased emails' {
        $emails = ConvertFrom-RoleCollectionJson -Json $script:fixture
        $emails | Should -Be @('alice@contoso.com','bob@contoso.com','carol@partner.io')
    }
    It 'returns empty array when there are no users' {
        $emails = ConvertFrom-RoleCollectionJson -Json '{"name":"X","userReferences":[]}'
        @($emails).Count | Should -Be 0
    }
}
```

- [ ] **Step 3: Run test to verify it fails**

Run:
```bash
pwsh -NoProfile -Command "Invoke-Pester tests/AuthorsToTeams.Tests.ps1 -Output Detailed"
```
Expected: FAIL — `ConvertFrom-RoleCollectionJson` not recognized.

- [ ] **Step 4: Implement the function**

Create `scripts/AuthorsToTeams.psm1`:
```powershell
function ConvertFrom-RoleCollectionJson {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Json)

    $obj = $Json | ConvertFrom-Json
    $refs = @()
    if ($obj.PSObject.Properties.Name -contains 'userReferences') { $refs = $obj.userReferences }
    elseif ($obj.PSObject.Properties.Name -contains 'users')      { $refs = $obj.users }

    $emails = foreach ($r in $refs) {
        $val = if ($r.email) { $r.email } else { $r.userName }
        if ($val) { $val.Trim().ToLowerInvariant() }
    }
    return [string[]]@($emails | Where-Object { $_ } | Select-Object -Unique)
}

Export-ModuleMember -Function ConvertFrom-RoleCollectionJson
```

- [ ] **Step 5: Run test to verify it passes**

Run:
```bash
pwsh -NoProfile -Command "Invoke-Pester tests/AuthorsToTeams.Tests.ps1 -Output Detailed"
```
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add scripts/AuthorsToTeams.psm1 tests/AuthorsToTeams.Tests.ps1 tests/fixtures/role-collection.json
git commit -m "feat: parse BTP role-collection JSON into deduped emails"
```

---

### Task 3: Split members by tenant domain

**Files:**
- Modify: `scripts/AuthorsToTeams.psm1`
- Test: `tests/AuthorsToTeams.Tests.ps1`

**Interfaces:**
- Consumes: email list from `ConvertFrom-RoleCollectionJson`.
- Produces: `Split-MembersByTenant -Emails <string[]> -TenantDomain <string>` → `[pscustomobject]@{ Internal = [string[]]; External = [string[]] }`. Case-insensitive domain match on the part after `@`.

- [ ] **Step 1: Write the failing test**

Add to `tests/AuthorsToTeams.Tests.ps1`:
```powershell
Describe 'Split-MembersByTenant' {
    It 'separates internal from external by domain' {
        $r = Split-MembersByTenant -Emails @('alice@contoso.com','carol@partner.io') -TenantDomain 'contoso.com'
        $r.Internal | Should -Be @('alice@contoso.com')
        $r.External | Should -Be @('carol@partner.io')
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
pwsh -NoProfile -Command "Invoke-Pester tests/AuthorsToTeams.Tests.ps1 -Output Detailed"
```
Expected: FAIL — `Split-MembersByTenant` not recognized.

- [ ] **Step 3: Implement the function**

Add to `scripts/AuthorsToTeams.psm1` (and add `Split-MembersByTenant` to the `Export-ModuleMember` list):
```powershell
function Split-MembersByTenant {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string[]]$Emails,
        [Parameter(Mandatory)][string]$TenantDomain
    )
    $dom = $TenantDomain.Trim().ToLowerInvariant()
    $internal = @(); $external = @()
    foreach ($e in $Emails) {
        $suffix = ($e -split '@')[-1].ToLowerInvariant()
        if ($suffix -eq $dom) { $internal += $e } else { $external += $e }
    }
    [pscustomobject]@{ Internal = [string[]]$internal; External = [string[]]$external }
}
```
Update export line:
```powershell
Export-ModuleMember -Function ConvertFrom-RoleCollectionJson, Split-MembersByTenant
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
pwsh -NoProfile -Command "Invoke-Pester tests/AuthorsToTeams.Tests.ps1 -Output Detailed"
```
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/AuthorsToTeams.psm1 tests/AuthorsToTeams.Tests.ps1
git commit -m "feat: split role-collection members into internal/external by tenant domain"
```

---

### Task 4: Add members to the channel (idempotent, with summary)

**Files:**
- Modify: `scripts/AuthorsToTeams.psm1`
- Test: `tests/AuthorsToTeams.Tests.ps1`

**Interfaces:**
- Consumes: internal emails from `Split-MembersByTenant`; `-TeamId`, `-ChannelId`.
- Produces: `Add-MembersToChannel -Emails <string[]> -TeamId <string> -ChannelId <string> [-WhatIf]` → `[pscustomobject]@{ Added=[string[]]; AlreadyMember=[string[]]; Failed=[string[]] }`. Calls `New-MgTeamChannelMember` once per email with an `aadUserConversationMember` body binding `user@odata.bind` to `https://graph.microsoft.com/v1.0/users('<email>')` and `roles=@()`. A thrown error whose message matches `already exist|conflict|duplicate` is recorded in `AlreadyMember`; any other throw is recorded in `Failed`. Under `-WhatIf`, makes no calls and returns all emails in `Added` (as planned adds).

- [ ] **Step 1: Write the failing test**

Add to `tests/AuthorsToTeams.Tests.ps1`:
```powershell
Describe 'Add-MembersToChannel' {
    It 'adds new members and classifies existing/failed' {
        Mock -ModuleName AuthorsToTeams New-MgTeamChannelMember {
            param($TeamId, $ChannelId, $BodyParameter)
            $bind = $BodyParameter['user@odata.bind']
            if ($bind -match 'bob') { throw 'One or more added object references already exist for the following modified properties: members.' }
            if ($bind -match 'carol') { throw 'Request_ResourceNotFound: user not found' }
        }
        $r = Add-MembersToChannel -Emails @('alice@contoso.com','bob@contoso.com','carol@contoso.com') -TeamId 't' -ChannelId 'c'
        $r.Added         | Should -Be @('alice@contoso.com')
        $r.AlreadyMember | Should -Be @('bob@contoso.com')
        $r.Failed        | Should -Be @('carol@contoso.com')
    }
    It 'makes no calls under WhatIf' {
        Mock -ModuleName AuthorsToTeams New-MgTeamChannelMember { throw 'should not be called' }
        $r = Add-MembersToChannel -Emails @('alice@contoso.com') -TeamId 't' -ChannelId 'c' -WhatIf
        $r.Added | Should -Be @('alice@contoso.com')
        Should -Invoke -ModuleName AuthorsToTeams New-MgTeamChannelMember -Times 0
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
pwsh -NoProfile -Command "Invoke-Pester tests/AuthorsToTeams.Tests.ps1 -Output Detailed"
```
Expected: FAIL — `Add-MembersToChannel` not recognized.

- [ ] **Step 3: Implement the function**

Add to `scripts/AuthorsToTeams.psm1`. Import the Graph Teams module at top of the psm1 so the mock target resolves:
```powershell
Import-Module Microsoft.Graph.Teams -ErrorAction SilentlyContinue

function Add-MembersToChannel {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][string[]]$Emails,
        [Parameter(Mandatory)][string]$TeamId,
        [Parameter(Mandatory)][string]$ChannelId
    )
    $added = @(); $already = @(); $failed = @()
    foreach ($e in $Emails) {
        if (-not $PSCmdlet.ShouldProcess($e, "Add to channel $ChannelId")) {
            $added += $e   # WhatIf: planned add
            continue
        }
        $body = @{
            '@odata.type'      = '#microsoft.graph.aadUserConversationMember'
            'roles'            = @()
            'user@odata.bind'  = "https://graph.microsoft.com/v1.0/users('$e')"
        }
        try {
            New-MgTeamChannelMember -TeamId $TeamId -ChannelId $ChannelId -BodyParameter $body -ErrorAction Stop | Out-Null
            $added += $e
        } catch {
            if ($_.Exception.Message -match 'already exist|conflict|duplicate') { $already += $e }
            else { $failed += $e; Write-Warning "Failed to add ${e}: $($_.Exception.Message)" }
        }
    }
    [pscustomobject]@{ Added=[string[]]$added; AlreadyMember=[string[]]$already; Failed=[string[]]$failed }
}
```
Update export line:
```powershell
Export-ModuleMember -Function ConvertFrom-RoleCollectionJson, Split-MembersByTenant, Add-MembersToChannel
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
pwsh -NoProfile -Command "Invoke-Pester tests/AuthorsToTeams.Tests.ps1 -Output Detailed"
```
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/AuthorsToTeams.psm1 tests/AuthorsToTeams.Tests.ps1
git commit -m "feat: idempotent channel-member add with WhatIf and result summary"
```

---

### Task 5: Orchestrator script with session checks, fetch, preview, confirm, summary

**Files:**
- Create: `scripts/Add-AuthorsToTeamsChannel.ps1`

**Interfaces:**
- Consumes: all three module functions.
- Produces: runnable entry point. Exit code `0` on success, `1` if `Failed` is non-empty or a session is missing.

- [ ] **Step 1: Write the orchestrator**

Create `scripts/Add-AuthorsToTeamsChannel.ps1`:
```powershell
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
```

- [ ] **Step 2: Syntax-check the script parses**

Run:
```bash
pwsh -NoProfile -Command "\$null = [System.Management.Automation.Language.Parser]::ParseFile('scripts/Add-AuthorsToTeamsChannel.ps1',[ref]\$null,[ref]\$null); 'parsed ok'"
```
Expected: `parsed ok`.

- [ ] **Step 3: Dry-run against the real role collection (no writes)**

Run (fill in the real values; requires `btp login` + `Connect-MgGraph`):
```bash
pwsh -NoProfile -Command "Connect-MgGraph -Scopes 'ChannelMember.ReadWrite.All'; ./scripts/Add-AuthorsToTeamsChannel.ps1 -RoleCollection '<NAME>' -TeamId '<TEAM>' -ChannelId '<CHANNEL>' -TenantDomain '<contoso.com>' -WhatIf"
```
Expected: prints the internal/external lists and a summary with `Added` = internal count, zero real calls.

- [ ] **Step 4: Commit**

```bash
git add scripts/Add-AuthorsToTeamsChannel.ps1
git commit -m "feat: orchestrator to add PROD role-collection authors to Teams shared channel"
```

---

### Task 6: Full test run + README note

**Files:**
- Create: `scripts/README.md`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Run the whole suite**

Run:
```bash
pwsh -NoProfile -Command "Invoke-Pester tests/ -Output Detailed"
```
Expected: all tests PASS.

- [ ] **Step 2: Write usage README**

Create `scripts/README.md`:
```markdown
# Add-AuthorsToTeamsChannel

Adds members of a PROD BTP role collection to a Microsoft Teams shared channel.

## Prerequisites
- `btp login` (BTP CLI authenticated to the PROD subaccount)
- `Connect-MgGraph -Scopes "ChannelMember.ReadWrite.All"`
- PowerShell 7+, `Microsoft.Graph.Teams` module

## Usage
```powershell
./Add-AuthorsToTeamsChannel.ps1 `
  -RoleCollection "SWAPI_Author" `
  -TeamId    "<team-id>" `
  -ChannelId "<channel-id>" `
  -TenantDomain "contoso.com" `
  [-SubaccountGuid "<guid>"] `
  [-WhatIf]
```
Use `-WhatIf` first to preview. External-domain members are always skipped and reported.
```

- [ ] **Step 3: Commit**

```bash
git add scripts/README.md
git commit -m "docs: usage README for Add-AuthorsToTeamsChannel"
```

---

## Self-Review

**Spec coverage:**
- Fetch via btp CLI → Task 5 (fetch block) + Task 2 (parse). ✓
- Preview + confirm + `-WhatIf` → Task 5. ✓
- `New-MgTeamChannelMember` (correct cmdlet) → Task 4. ✓
- `ChannelMember.ReadWrite.All` scope → Task 5 session check + README. ✓
- Shared-channel direct add → Task 4. ✓
- In-tenant assumption + skipped-external guard → Task 3 + Task 5. ✓
- Two-session auth check → Task 5 (Graph via Get-MgContext; BTP via error-string guard on fetch). ✓
- Idempotency ("already a member") → Task 4. ✓
- Summary counts + non-zero exit on failure → Task 5. ✓
- Fetch/parse testable from captured JSON → Task 2 fixture. ✓
- Parameters (`-RoleCollection`, `-SubaccountGuid` default, `-TeamId`, `-ChannelId`, `-WhatIf`) → Task 5. Note: `-TenantDomain` added as a required param (needed for the external guard; spec implied tenant domain without naming a source).

**Placeholder scan:** No TBD/TODO. `<NAME>`/`<TEAM>` in Task 5 Step 3 and README are genuine run-time inputs, called out in the spec as required-at-run-time.

**Type consistency:** `ConvertFrom-RoleCollectionJson`→`[string[]]`; `Split-MembersByTenant`→`.Internal`/`.External`; `Add-MembersToChannel`→`.Added`/`.AlreadyMember`/`.Failed`. Names used consistently in Task 5. ✓
