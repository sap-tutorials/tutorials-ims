# Import Microsoft.Graph.Teams so mock target can resolve
Import-Module Microsoft.Graph.Teams -ErrorAction SilentlyContinue

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
            Invoke-ChannelMemberAdd -TeamId $TeamId -ChannelId $ChannelId -Body $body | Out-Null
            $added += $e
        } catch {
            if ($_.Exception.Message -match 'already exist|conflict|duplicate') { $already += $e }
            else { $failed += $e; Write-Warning "Failed to add ${e}: $($_.Exception.Message)" }
        }
    }
    [pscustomobject]@{ Added=[string[]]$added; AlreadyMember=[string[]]$already; Failed=[string[]]$failed }
}

function Invoke-ChannelMemberAdd {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$TeamId,
        [Parameter(Mandatory)][string]$ChannelId,
        [Parameter(Mandatory)][hashtable]$Body
    )
    New-MgTeamChannelMember -TeamId $TeamId -ChannelId $ChannelId -BodyParameter $Body -ErrorAction Stop
}

Export-ModuleMember -Function ConvertFrom-RoleCollectionJson, Split-MembersByTenant, Add-MembersToChannel, Invoke-ChannelMemberAdd
