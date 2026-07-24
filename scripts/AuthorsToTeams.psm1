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
