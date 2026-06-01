#!/usr/bin/env tsx
/**
 * One-shot harvester: pulls (titlePath, label) pairs from the AEM Solr endpoint
 * at developers.sap.com, matches them to existing rows in HANA Tags by titlePath,
 * and PATCHes Tags.label via the CAP /admin/Tags OData endpoint.
 *
 * Run once at cutover; re-run if AEM ships new tags before going dark.
 *
 * Auth (pick one):
 *   ADMIN_BEARER_TOKEN — Bearer JWT for deployed CAP. Must be an XSUAA-issued user token
 *     with the `Admin` scope (a `cf oauth-token` will NOT work — that's a CF UAA token,
 *     different issuer). Easiest source: copy from your browser session at /admin-ui/.
 *   ADMIN_BASIC_AUTH  — "user:password" for local CAP with mocked auth (e.g. "admin:admin").
 *     Use with CAP_BASE_URL=http://localhost:4004 (default) when running locally via cds bind.
 *
 * Target: CAP_BASE_URL env var, defaults to http://localhost:4004.
 *
 * Usage (local, against real HANA via cds bind):
 *   # Start CAP first: npx cds bind --exec -- cds watch
 *   ADMIN_BASIC_AUTH="admin:admin" npm run seed-tag-labels -- --dry-run
 *
 * Usage (deployed):
 *   ADMIN_BEARER_TOKEN="<xsuaa-user-token>" \
 *   CAP_BASE_URL="https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com" \
 *   npm run seed-tag-labels
 *
 * Flags:
 *   --dry-run   Report what would be PATCHed without making changes.
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const SOLR_URL = 'https://developers.sap.com/bin/sapdx/v3/solr/search'
const SOLR_PAGE_PATH = '/content/developers/website/languages/en/tutorial-navigator'
const CAP_URL = process.env.CAP_BASE_URL ?? 'http://localhost:4004'
const ADMIN_TOKEN = process.env.ADMIN_BEARER_TOKEN
const ADMIN_BASIC = process.env.ADMIN_BASIC_AUTH   // "user:password" for local mocked auth
const DRY_RUN = process.argv.includes('--dry-run')

function authHeaders(): Record<string, string> {
  if (ADMIN_TOKEN) return { Authorization: `Bearer ${ADMIN_TOKEN}` }
  if (ADMIN_BASIC) return { Authorization: `Basic ${Buffer.from(ADMIN_BASIC).toString('base64')}` }
  throw new Error('Set ADMIN_BEARER_TOKEN (deployed) or ADMIN_BASIC_AUTH (local) env var')
}

export interface AemTagPair { tagTitle: string; label: string }
export interface SolrResponse {
  tags?: Record<string, { title?: string; tagTitle?: string; tagAlternativeTitles?: string[] }> | null
}

/**
 * Extracts { tagTitle, label } pairs from the raw Solr JSON object.
 * Skips entries missing tagTitle or a non-empty title.
 * Trims whitespace from labels.
 */
export function parseAemTagPayload(response: unknown): AemTagPair[] {
  const r = response as SolrResponse
  if (!r?.tags || typeof r.tags !== 'object') return []
  const result: AemTagPair[] = []
  for (const entry of Object.values(r.tags)) {
    if (!entry) continue
    const tagTitle = entry.tagTitle?.trim()
    const label = entry.title?.trim()
    if (!tagTitle || !label) continue
    result.push({ tagTitle, label })
  }
  return result
}

/**
 * Returns an ordered array of candidate HANA titlePath values to try for a given
 * AEM tagTitle. First match in the HANA Tags table wins.
 *
 * AEM tagTitle format:  <namespace>:<seg1>/<seg2>/.../<last>
 * HANA titlePath format: <namespace>><slug>
 *   where <namespace> uses `>` instead of `:` and the rest is a single slug segment
 *   (or occasionally a short hierarchy joined with `>`).
 *
 * Priority order:
 *   1. ns>last                           — namespace + last segment
 *   2. ns>last-with-ns-prefix-stripped   — if last starts with "<ns>-", strip that prefix
 *   3. ns>last-with-double-hyphen        — replace hyphens around likely encoded chars
 *   4. ns>seg[-2]>last                   — penultimate + last (short hierarchy)
 *   5. ns>seg1>seg2>...>last             — full hierarchy
 *
 * Returns [] for malformed input (no colon).
 */
export function aemTagTitleToHanaTitlePath(tagTitle: string): string[] {
  if (!tagTitle) return []
  const colonIdx = tagTitle.indexOf(':')
  if (colonIdx === -1) return []

  const ns = tagTitle.slice(0, colonIdx)
  const rest = tagTitle.slice(colonIdx + 1)
  if (!rest) return []

  const segs = rest.split('/')
  const last = segs[segs.length - 1]
  if (!last) return []

  const seen = new Set<string>()
  const candidates: string[] = []

  const add = (c: string) => {
    if (!seen.has(c)) { seen.add(c); candidates.push(c) }
  }

  // Candidate 1: ns>last
  add(`${ns}>${last}`)

  // Candidate 2: strip redundant namespace prefix from last segment
  // e.g. programming-tool:programming-tool-api → programming-tool>api
  const nsPrefix = `${ns}-`
  if (last.startsWith(nsPrefix)) {
    add(`${ns}>${last.slice(nsPrefix.length)}`)
  }

  // Candidate 3: double-hyphen variant — HANA encodes commas and slashes
  // in slugs as `--`. Try replacing hyphens that separate the penultimate
  // and last tokens with `--`.
  // e.g. sap-build-work-zone-advanced-edition → sap-build-work-zone--advanced-edition
  // Strategy: split last on `-` and try replacing each hyphen with `--` once.
  // We generate one variant per potential split point (rightmost first so the
  // "outer container" variant comes before noisier ones).
  const hyphenParts = last.split('-')
  if (hyphenParts.length >= 3) {
    // Try splitting at each hyphen from left to right to produce doubled-hyphen variants
    for (let i = 1; i < hyphenParts.length; i++) {
      const left = hyphenParts.slice(0, i).join('-')
      const right = hyphenParts.slice(i).join('-')
      const variant = `${ns}>${left}--${right}`
      add(variant)
    }
  }

  // Candidate 4: penultimate segment + last (short hierarchy)
  if (segs.length >= 2) {
    const penultimate = segs[segs.length - 2]
    if (penultimate) add(`${ns}>${penultimate}>${last}`)
  }

  // Candidate 5: full hierarchy (ns + all segments joined with >)
  if (segs.length >= 2) {
    add(`${ns}>${segs.join('>')}`)
  }

  return candidates
}

async function fetchSolr(): Promise<SolrResponse> {
  const json = JSON.stringify({
    rows: '500',
    start: 0,
    searchField: '',
    pagePath: SOLR_PAGE_PATH,
    language: 'en_us',
    addDefaultLanguage: true,
    filters: [],
  })
  const url = `${SOLR_URL}?json=${encodeURIComponent(json)}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Solr fetch failed: ${res.status} ${res.statusText}`)
  return res.json() as Promise<SolrResponse>
}

interface ExistingTagRow { ID: string; titlePath: string; label: string | null }

async function fetchExistingTags(): Promise<Map<string, ExistingTagRow>> {
  if (!ADMIN_TOKEN && !ADMIN_BASIC) throw new Error('Set ADMIN_BEARER_TOKEN (deployed) or ADMIN_BASIC_AUTH (local) env var')
  const url = `${CAP_URL}/admin/Tags?$select=ID,titlePath,label&$top=2000`
  const res = await fetch(url, { headers: authHeaders() })
  if (!res.ok) throw new Error(`CAP fetch failed: ${res.status} ${res.statusText} — ${await res.text()}`)
  const json = await res.json() as { value: ExistingTagRow[] }
  const map = new Map<string, ExistingTagRow>()
  for (const r of json.value) if (r.titlePath) map.set(r.titlePath, r)
  return map
}

async function patchLabel(id: string, label: string): Promise<void> {
  const url = `${CAP_URL}/admin/Tags(${id})`
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ label }),
  })
  if (!res.ok) throw new Error(`PATCH ${id} failed: ${res.status} ${res.statusText} — ${await res.text()}`)
}

async function main() {
  console.error(`[seed-tag-labels] CAP=${CAP_URL} dry-run=${DRY_RUN}`)
  const [solr, existing] = await Promise.all([fetchSolr(), fetchExistingTags()])
  const harvested = parseAemTagPayload(solr)
  console.error(`[seed-tag-labels] harvested ${harvested.length} (tagTitle,label) pairs from AEM`)
  console.error(`[seed-tag-labels] HANA has ${existing.size} Tags rows with titlePath`)

  let updated = 0, alreadySet = 0
  const unmatched: AemTagPair[] = []

  for (const pair of harvested) {
    const candidates = aemTagTitleToHanaTitlePath(pair.tagTitle)
    let hit: ExistingTagRow | null = null
    for (const c of candidates) {
      const row = existing.get(c)
      if (row) { hit = row; break }
    }
    if (!hit) { unmatched.push(pair); continue }
    if (hit.label === pair.label) { alreadySet++; continue }
    if (DRY_RUN) {
      console.error(`[dry-run] WOULD PATCH ${hit.titlePath} -> "${pair.label}" (was: ${hit.label === null ? 'NULL' : `"${hit.label}"`})`)
    } else {
      await patchLabel(hit.ID, pair.label)
    }
    updated++
  }

  console.error(`[seed-tag-labels] ${DRY_RUN ? 'would-update' : 'updated'}: ${updated}`)
  console.error(`[seed-tag-labels] already correct: ${alreadySet}`)
  console.error(`[seed-tag-labels] AEM-unmatched: ${unmatched.length} (no HANA row to label)`)

  if (unmatched.length) {
    const path = '.tutorial-cache/aem-tags-unmatched.json'
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(unmatched, null, 2))
    console.error(`[seed-tag-labels] wrote ${path}`)
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('seed-tag-labels.ts')) {
  main().catch(e => { console.error(e); process.exit(1) })
}
