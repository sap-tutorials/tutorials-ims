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

Describe 'Split-MembersByTenant' {
    It 'separates internal from external by domain' {
        $r = Split-MembersByTenant -Emails @('alice@contoso.com','carol@partner.io') -TenantDomain 'contoso.com'
        $r.Internal | Should -Be @('alice@contoso.com')
        $r.External | Should -Be @('carol@partner.io')
    }
}
