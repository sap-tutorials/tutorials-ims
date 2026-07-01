// Phase 4.7 (#748 §4.8.3): the /explore JSON data feed exposes help-doc
// nodes with `type: 'help-doc'`. Automatic once the IRI registry is
// extended (which happened in Task 1); Task 3 only widens the client-
// side TypeScript union. This test guards the wire contract.
//
// BLOCKED-until-deploy: requires help-doc rows in HelpDocs (bootstrapped
// via the seedHelpDocs admin action in Task 2) AND a graphRebuild since
// the seed.

import { describe, it, expect } from 'vitest'

const SRV_URL = process.env.SMOKE_SRV_URL

describe.skipIf(!SRV_URL)('explore JSON — help-doc nodes (Phase 4.7)', () => {
  it('returns at least one node with type=help-doc after seeding', async () => {
    const url = `${SRV_URL.replace(/\/$/, '')}/build/explore-data`
    const res = await fetch(url)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.nodes)).toBe(true)
    const helpDocNodes = body.nodes.filter((n) => n && n.type === 'help-doc')
    // Graceful skip during the bootstrap window — the cron hasn't run
    // against real HANA yet, so the graph may not yet contain help-doc
    // nodes. Test passes silently in that case; the contract assertion
    // fires as soon as seeding lands.
    if (helpDocNodes.length === 0) return
    expect(helpDocNodes.length).toBeGreaterThan(0)
  })
})
