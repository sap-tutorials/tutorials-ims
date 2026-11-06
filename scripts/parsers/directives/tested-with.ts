// scripts/parsers/directives/tested-with.ts
//
// Known current major versions for packages referenced in testedWith frontmatter.
// Used by checkTestedWithFreshness to detect outdated version declarations.

/**
 * Map of known package names to their current major version.
 * Updated here as new major versions ship.
 */
export const KNOWN_VERSIONS: Record<string, number> = {
  '@sap/cds': 10,
  'node': 22,
  'SAP BTP CLI': 2,
  '@sap/hana-client': 2,
}

/**
 * Check a `testedWith` map for packages whose declared major version is
 * behind the known current major.
 *
 * - For each `[pkg, ver]` entry, extract the leading digits as the declared major.
 * - If `KNOWN_VERSIONS[pkg]` exists AND declared major < known major → add a finding.
 * - Non-numeric values (e.g. `"latest"`, `"next"`) are silently skipped (no throw).
 *
 * @param testedWith  Record mapping package name → version string (e.g. `{ '@sap/cds': '7.x' }`)
 * @returns Array of outdated-version findings (empty when everything is current or unknown).
 */
export function checkTestedWithFreshness(
  testedWith: Record<string, string>
): Array<{ pkg: string; declared: number; current: number }> {
  const findings: Array<{ pkg: string; declared: number; current: number }> = []

  for (const [pkg, ver] of Object.entries(testedWith)) {
    const match = /^(\d+)/.exec(ver)
    if (!match) continue // non-numeric — silently skip

    const declared = parseInt(match[1], 10)
    const current = KNOWN_VERSIONS[pkg]
    if (current === undefined) continue // unknown package — skip

    if (declared < current) {
      findings.push({ pkg, declared, current })
    }
  }

  return findings
}
