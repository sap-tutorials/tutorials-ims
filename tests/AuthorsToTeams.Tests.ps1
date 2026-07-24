BeforeAll {
    Import-Module "$PSScriptRoot/../scripts/AuthorsToTeams.psm1" -Force
    Import-Module Microsoft.Graph.Teams -ErrorAction SilentlyContinue
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

Describe 'Split-MembersByTenant' {
    It 'separates internal from external by domain' {
        $r = Split-MembersByTenant -Emails @('alice@contoso.com','carol@partner.io') -TenantDomain 'contoso.com'
        $r.Internal | Should -Be @('alice@contoso.com')
        $r.External | Should -Be @('carol@partner.io')
    }
}

Describe 'Add-MembersToChannel' {
    It 'adds new members and classifies existing/failed' {
        Mock -ModuleName AuthorsToTeams Invoke-ChannelMemberAdd {
            param($TeamId, $ChannelId, $Body)
            $bind = $Body['user@odata.bind']
            if ($bind -match 'bob')   { throw 'One or more added object references already exist for the following modified properties: members.' }
            if ($bind -match 'carol') { throw 'Request_ResourceNotFound: user not found' }
        }
        $r = Add-MembersToChannel -Emails @('alice@contoso.com','bob@contoso.com','carol@contoso.com') -TeamId 't' -ChannelId 'c'
        $r.Added         | Should -Be @('alice@contoso.com')
        $r.AlreadyMember | Should -Be @('bob@contoso.com')
        $r.Failed        | Should -Be @('carol@contoso.com')
    }
    It 'makes no calls under WhatIf' {
        Mock -ModuleName AuthorsToTeams Invoke-ChannelMemberAdd { throw 'should not be called' }
        $r = Add-MembersToChannel -Emails @('alice@contoso.com') -TeamId 't' -ChannelId 'c' -WhatIf
        $r.Added | Should -Be @('alice@contoso.com')
        Should -Invoke -ModuleName AuthorsToTeams Invoke-ChannelMemberAdd -Times 0
    }
}
