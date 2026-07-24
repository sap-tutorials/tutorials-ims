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
