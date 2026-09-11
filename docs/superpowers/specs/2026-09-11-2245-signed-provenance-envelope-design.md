# Signed Tutorial Provenance & Freshness Attestation

- **Issue:** [#2245](https://github.com/sap-tutorials/tutorials-ims/issues/2245) — "Executable, self-verifying, self-healing tutorials" (idea #1: signed freshness/provenance signal)
- **Date:** 2026-09-11
- **Status:** Design approved (brainstorm); pending spec review → implementation plan
- **Scope:** Idea #1 only. Ideas #2–4 (assert blocks, tutorials-as-Skills, self-healing) are out of scope and depend on this as their trust spine.

## Problem

Staleness is the #1 cause of wrong AI SAP advice. When an AI agent fetches a tutorial (HTML or `.md`) to scaffold or answer, the content carries **no machine-readable signal** for the agent to judge how much to trust it or whether it is current. There is also no way for a third party to prove a given tutorial payload genuinely came from SAP unmodified.

We already own every hard piece: a shipped freshness detector (`srv/lib/freshness-detector.js`), a HANA-backed content serve path with content hashing, a source-commit SHA captured at fetch time, and a `.well-known` middleware seam. This design exposes a **cryptographically signed provenance + freshness attestation** an agent can fetch and verify.

## Goals

- A per-tutorial signed envelope any third-party agent can verify **offline** against a published public key, with no shared secret.
- Two **distinct** claims — factual provenance and derived staleness — never collapsed into one opaque score.
- Cheap advisory headers on the existing serve path so an agent doing a `HEAD`/`GET` gets a hint and a pointer without parsing crypto.
- Fail-open: the attestation never blocks or degrades content delivery.

## Non-goals (YAGNI)

- No automated **key-rotation job** — the format is rotation-ready (JWKS lists multiple keys) but rotation stays a manual op for now.
- No **per-step** provenance — attestation is per-tutorial.
- No envelopes for homepage / content-pages / concepts — **tutorials only**.
- No signing of the HTML bytes inline (no JSON-LD embed) — the envelope is a separate resource.
- Not idea #2/#3/#4. No executable assertions, no `SKILL.md` generation, no self-healing PRs.

## Approved design

### A. Envelope format — JWS / EdDSA (Ed25519)

Use a standard **flattened JWS** (RFC 7515) with `alg: EdDSA`, `crv: Ed25519`, rather than a bespoke signature. Any consuming agent verifies with an off-the-shelf JOSE library plus the published JWKS — no custom crypto for us to document or for them to reimplement.

JWS protected header:

```json
{ "alg": "EdDSA", "kid": "<key id>", "typ": "application/tutorial-provenance+jws" }
```

Payload (claims):

```jsonc
{
  "iss": "https://developers.sap.com",
  "sub": "<slug>",                       // lowercase-canonical slug
  "iat": 1757600000,
  "exp": 1757686400,                     // TTL bounds staleness of the ATTESTATION itself (see E)
  "contentHash": "<sha256 of served HTML>",  // binds the signature to exact served bytes (= ETag)
  "provenance": {                        // FACTUAL claim — no judgment
    "sourceRepo": "sap-tutorials/Tutorials",
    "sourceCommit": "<currentSha or null>",
    "builtAt": "<publish timestamp>"
  },
  "freshness": {                         // JUDGMENT claim — derived (see B)
    "confidence": "high|medium|low|unknown",
    "lastScanned": "<FreshnessReport.runAt or null>",
    "openHighCount": 0,
    "detectorModel": "<model string or null>"   // transparency: which LLM judged
  }
}
```

The two claim groups are kept as separate objects on purpose: `provenance` is verifiable fact; `freshness` is an LLM-derived judgment. An agent may weight them independently (e.g. trust an old-but-clean tutorial while down-weighting a recently-scanned-but-flagged one).

### B. Freshness confidence derivation

Deterministic mapping from the latest `FreshnessReport` for the tutorial — **no LLM call at serve time**. Thresholds are constants (candidate values below; confirm in review):

| confidence | condition |
|-----------|-----------|
| `high`    | latest scan ≤ 30d old **and** `openHighCount == 0` **and** no open Medium finding |
| `medium`  | clean but aging (scan 30–90d old), **or** only open Low/Medium findings |
| `low`     | any open **High** finding, **or** latest scan > 90d old |
| `unknown` | never scanned, no report, or freshness feature disabled |

`unknown` is honest — we never fake `high` in the absence of a scan. "Open" respects `FreshnessFinding` disposition (ACCEPTED/DISMISSED/FIXED findings do not count against confidence; only OPEN does).

### C. Keys — Ed25519 + JWKS

- **Private key** stored in the BTP Credential Store (same seam as `CONTENT_API_KEY`), loaded once at boot. Never in source or committed env. Absent key ⇒ feature fails open (disabled), logged once.
- **`kid`** identifies the signing key in the JWS header.
- **Public keys** published as a JWKS document at `GET /.well-known/tutorial-provenance/jwks.json`, reusing the existing `.well-known` approuter-middleware seam (`docs/.../2026-08-28-well-known-oauth-discovery-design.md`). Anonymous, cacheable.
- **Rotation-ready:** JWKS may list multiple public keys; we sign with the newest `kid`. Old public keys remain published until all envelopes signed under them have expired. No rotation automation built now.

### D. Endpoint + serve integration

- **`GET /content/tutorials/:slug/provenance`** → returns the flattened JWS as `application/jose+json` (or a thin wrapper `{ jws, jwks_url }`). Anonymous, CDN-frontable, tagged with the **same `Edge-Cache-Tag`** as the tutorial so it purges together on republish.
- **Advisory (unsigned) headers** added to the existing HTML serve path (`serveStoredSlug`, `srv/lib/content-store.js`):
  - `X-Freshness-Confidence: high|medium|low|unknown`
  - `X-Content-Provenance: /content/tutorials/:slug/provenance`
  These are hints, not trust anchors — an agent that wants assurance fetches and verifies the JWS.
- **Cache-hit correctness:** the advisory values must be stored **inside the LRU-cached object** alongside `{ buffer, hash }`, because the cache-hit branch bypasses the DB read. Otherwise cache hits would silently drop the headers (this is the gotcha flagged during grounding).

### E. Signing lifecycle

Sign **on first serve**, cache the JWS keyed by `(contentHash, freshnessReportRunAt)`. Re-sign only when the content changes (new `contentHash`) or the freshness report changes (`runAt` advances). No coupling to the publish transaction for signing. `exp` = `iat + ATTESTATION_TTL` (candidate 24h) so an attestation cannot be replayed indefinitely; expiry forces a re-sign that re-reads current freshness.

### F. Data plumbing for `sourceCommit`

The source SHA (`currentSha`) is captured in `scripts/fetch-tutorials.ts` (written to `.tutorial-cache/<slug>.sha`, used as the cache-invalidation key) but discarded afterward. Plumb it through:

1. `fetch-tutorials.ts` — retain `currentSha` per slug into the publish input.
2. `scripts/publish-content.ts` → `POST /content/publish/append` payload — add `sourceCommit`.
3. New `sourceCommit : String(64)` column on the content aspect in `db/_content-shape.cds` (carried by `ContentCurrent` / `ContentManifest`). Migration via `cds build --production`.
4. Pre-existing rows: `sourceCommit` is null ⇒ the `provenance.sourceCommit` claim is emitted as `null` (honest; not fabricated).

> Review question F: store `sourceCommit` on `ContentCurrent` (per-serve read, no extra query) or on `ContentManifest` only (one row per publish, needs a join at serve)? Default: `ContentCurrent` for cheap serve-time read.

### G. Feature flag + fail-open

- DB-config flag **`PROVENANCE_ENVELOPE_ENABLED`** registered in `srv/.../feature-flags/registry.js` (`kind:'db'`, `dev-only` first, default OFF). Per project rule, feature flags are DB config, never env (blue-green drops `cf set-env`).
- Flag OFF ⇒ `/provenance` returns 404, no advisory headers emitted.
- **Fail-open everywhere:** any signing error, missing key, or freshness lookup failure ⇒ content serves normally; the envelope endpoint returns 503; nothing throws into the content path.

### H. Testing

Deterministic unit coverage (no live LLM, no live HANA — SQLite/in-memory per project test conventions):

- Confidence derivation table (each row of B, incl. disposition handling).
- Envelope claim shape and required fields.
- JWS round-trips: verifies against the matching public key; **tamper** (mutated payload) ⇒ verification fails; wrong `kid` ⇒ fails.
- JWKS document shape and that the served public key matches the signing key.
- Flag OFF path (404, no headers); missing report ⇒ `unknown`; null `sourceCommit` ⇒ null claim.
- Cache-hit path still emits advisory headers.

## Components & seams (existing code to attach to)

| Concern | Seam |
|---|---|
| Freshness data | `srv/lib/freshness-detector.js`, `db/tutorial-freshness.cds` (`FreshnessReport`/`FreshnessFinding`) |
| Serve path + headers + LRU | `srv/lib/content-store.js` (`serveStoredSlug`), header sites; `srv/server.js:~760` route |
| Content identity | existing `contentHash`/ETag on the served row |
| Source SHA | `scripts/fetch-tutorials.ts` (`currentSha`), `scripts/publish-content.ts`, `/content/publish/append` |
| Schema | `db/_content-shape.cds` (content aspect) |
| Key distribution | `.well-known` middleware seam (2026-08-28 design) |
| Flag | `feature-flags/registry.js` (`kind:'db'`) |
| New module | `srv/lib/provenance-envelope.js` (build + sign + cache), `srv/lib/provenance-keys.js` (key load + JWKS) |

## Review questions — RESOLVED (defaults approved 2026-09-11)

1. **B** — thresholds 30d (`high`) / 90d (`low`) and attestation TTL 24h ship as **constants** in the new module (not DB-config for v1).
2. **C** — JWKS served at **`/.well-known/tutorial-provenance/jwks.json`** via the existing `.well-known` middleware seam.
3. **F** — `sourceCommit` stored on **`ContentCurrent`** for cheap serve-time read.
4. **Crypto** — **Node native `crypto`** Ed25519 (`sign`/`verify` with `'Ed25519'`) + minimal flattened-JWS assembly; **no new runtime dependency** (confirm `jose` is not already resolvable at plan time — if it is, reuse it).
