#!/usr/bin/env node
// scripts/check-security-txt-drift.cjs
//
// Detects when SAP's canonical security.txt has changed upstream relative to
// the copy we serve from approuter/lib/security-txt.js.
//
// Drift source: https://www.sap.com/.well-known/security.txt
//   This is SAP's PUBLIC mirror of the internal source-of-truth repo
//   (github.tools.sap/sgsc-engineering-and-automation/securitytxt, maintained
//   by the SGSC PSRT team). We diff against www.sap.com, not the repo, because:
//     - the origin repo is SAP-internal and unreachable from GitHub.com hosted
//       runners, and we hold no Actions token for github.tools.sap;
//     - www.sap.com needs no token or internal network and serves byte-identical
//       content.
//
// Exit codes (mirrors the publish-content drift convention):
//   0 = match (our served copy equals upstream)
//   1 = tooling/connectivity failure (could not fetch or read)
//   2 = drift detected (upstream changed — a PR should update SECURITY_TXT)
//
// On drift, prints the upstream content to stdout after a `===UPSTREAM===`
// marker so the workflow can capture it and write it into the PR branch.

const path = require('node:path')

const UPSTREAM_URL = 'https://www.sap.com/.well-known/security.txt'
const FETCH_TIMEOUT_MS = 20000

// Normalize for comparison: CRLF -> LF, strip a trailing blank line's worth of
// whitespace differences but keep a single trailing newline. We compare the
// meaningful bytes, tolerant of edge/proxy line-ending rewrites.
function normalize(s) {
  return String(s).replace(/\r\n/g, '\n').replace(/\s+$/, '') + '\n'
}

async function main() {
  let SECURITY_TXT
  try {
    ({ SECURITY_TXT } = require(path.join('..', 'approuter', 'lib', 'security-txt.js')))
  } catch (err) {
    console.error(`[security-txt-drift] cannot load approuter/lib/security-txt.js: ${err.message}`)
    return 1
  }

  let upstream
  try {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS)
    const res = await fetch(UPSTREAM_URL, {
      signal: ac.signal,
      headers: { 'User-Agent': 'tutorials-ims-security-txt-drift-check' },
    })
    clearTimeout(t)
    if (!res.ok) {
      console.error(`[security-txt-drift] upstream ${UPSTREAM_URL} returned HTTP ${res.status}`)
      return 1
    }
    upstream = await res.text()
  } catch (err) {
    console.error(`[security-txt-drift] failed to fetch ${UPSTREAM_URL}: ${err.message}`)
    return 1
  }

  const ours = normalize(SECURITY_TXT)
  const theirs = normalize(upstream)

  if (ours === theirs) {
    console.log('[security-txt-drift] ✅ match — our served security.txt equals upstream (www.sap.com).')
    return 0
  }

  console.error('[security-txt-drift] ⚠️ DRIFT — upstream security.txt differs from our served copy.')
  console.error('')
  console.error('--- ours (approuter/lib/security-txt.js) ---')
  console.error(ours)
  console.error('--- upstream (www.sap.com) ---')
  console.error(theirs)
  // Machine-readable block for the workflow to capture the new content.
  console.log('===UPSTREAM===')
  process.stdout.write(theirs)
  console.log('===END-UPSTREAM===')
  return 2
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[security-txt-drift] unexpected error: ${err && err.stack || err}`)
    process.exit(1)
  })
