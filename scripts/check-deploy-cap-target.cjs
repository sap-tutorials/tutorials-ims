// scripts/check-deploy-cap-target.cjs
//
// Deploy-time guard. Fails loudly if a production build is about to bake
// CAP-sourced Hugo content (concepts, advocates, homepage shelves, browse)
// against the DEFAULT localhost:4004 backend — a plain `cds watch` that has
// ZERO admin-published concepts and CSV-only shelf data.
//
// Root cause it prevents (2026-07-12 empty-concepts incident, PR #1158):
//   `npm run build:all` fetches every CAP-sourced section from CAP_BASE_URL
//   (default http://localhost:4004). The canonical local-deploy runbook ran
//   bare `npm run build:all` with no CAP_BASE_URL, so `mbt build` baked an
//   EMPTY /concepts/ index into the MTA archive. Every deploy then shipped
//   that empty page until a separate content-rebuild patched the ephemeral
//   approuter disk — which the next deploy reverted. PR #1158 added a
//   boot-time self-heal; this guard closes the OTHER half: make the baked
//   MTA correct in the first place.
//
// This is a companion to scripts/check-verb-shelves.cjs. That guard fires
// AFTER the fetch (empty baked data); this one fires BEFORE it (wrong target),
// so the operator gets a fast, actionable error instead of a 10-minute build
// that ships empty content.
//
// Why a chained && / explicit `build:deploy` step instead of a lifecycle hook?
// Global npm config sets `ignore-scripts=true` (supply-chain policy), which
// blocks pre/post hooks. Mirrors check-explore-bundle-manifest.cjs.
//
// Exit codes:
//   0  CAP_BASE_URL is set to an explicit non-localhost backend.
//   1  CAP_BASE_URL is unset, empty, or points at localhost / 127.0.0.1.

// ---------------------------------------------------------------------------
// Pure core (unit-tested in scripts/__tests__/check-deploy-cap-target.test.ts).
// Given a candidate CAP_BASE_URL string, decide whether it is a safe deploy
// target. Returns { ok, reason }. A localhost / loopback / unset URL is unsafe
// for a deploy build because that backend has no admin-published content.
// ---------------------------------------------------------------------------
function evaluateDeployTarget(rawUrl) {
  const url = (rawUrl || '').trim();
  if (!url) {
    return { ok: false, reason: 'unset' };
  }

  let host;
  try {
    // URL.hostname wraps IPv6 in brackets ("[::1]") — strip them so the
    // loopback set matches on the bare address.
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
  if (LOOPBACK.has(host)) {
    return { ok: false, reason: 'localhost' };
  }

  return { ok: true, reason: 'ok' };
}

module.exports = { evaluateDeployTarget };

// ---------------------------------------------------------------------------
// CLI (only when run directly, so the pure core imports cleanly under Vitest).
// ---------------------------------------------------------------------------
if (require.main === module) {
  const raw = process.env.CAP_BASE_URL;
  const { ok, reason } = evaluateDeployTarget(raw);

  if (ok) {
    console.log(`[build:deploy] CAP_BASE_URL target OK: ${raw}`);
    process.exit(0);
  }

  const detail = {
    unset: 'CAP_BASE_URL is not set — the build would default to http://localhost:4004.',
    malformed: `CAP_BASE_URL is not a valid URL: "${raw}".`,
    localhost: `CAP_BASE_URL points at a local backend: "${raw}".`,
  }[reason] || `CAP_BASE_URL is unusable (${reason}).`;

  console.error('');
  console.error('[build:deploy] deploy-target guard FAILED:');
  console.error(`             ${detail}`);
  console.error('');
  console.error('             A deploy build bakes CAP-sourced Hugo pages (/concepts/,');
  console.error('             /developer-advocates/, /browse/, homepage shelves) into the MTA');
  console.error('             archive. A local `cds watch` backend has ZERO admin-published');
  console.error('             concepts, so the build would ship an EMPTY /concepts/ index —');
  console.error('             the 2026-07-12 incident.');
  console.error('');
  console.error('             Fix: point CAP_BASE_URL at the target environment\'s deployed srv,');
  console.error('             e.g. for DEV:');
  console.error('');
  console.error('               export CAP_BASE_URL="https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com"');
  console.error('               npm run build:deploy');
  console.error('');
  console.error('             (Use `npm run build:all` directly only for local dev builds,');
  console.error('             where an empty concepts index is expected.)');
  console.error('');
  process.exit(1);
}
