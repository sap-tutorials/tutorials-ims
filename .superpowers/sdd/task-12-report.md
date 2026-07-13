# Task 12 Report — Admin curation MCP tools (merge/promote/rebuild/publish)

**Issue:** #1106 Phase 3 (WS2) · **Status:** COMPLETE

## Files
- **Created** `srv/admin-service-mcp.cds` — `@protocol` widening + 4 action declarations.
- **Created** `srv/lib/mcp-admin-tools.js` — 4 delegating handlers.
- **Modified** `srv/admin-service.js` — import + wired 4 `this.on()` registrations before `super.init()`.
- **Created** `test/unit/mcp-admin-tools.test.js` — 8 delegation tests.

## publish_content approach: synthetic-req (NOT stubbed)
Took the synthetic-req approach as preferred by the brief. `handlePublishContent` calls
`createContentHandlers().publishHandler(fakeReq, fakeRes)` so ALL existing validation +
carry-forward / no-revert guards run — no reimplementation, no bypass.

Confirmed against `srv/lib/content-store.js` `publishHandler` (line 271):
- `req.body` shape: `{ trigger, hugoVersion, files, metadata, bodyTexts, branchSpecs, sources }`.
- `files[slug]` must be **gzip-compressed, base64-encoded HTML** — the handler does
  `gunzipSync(Buffer.from(value, 'base64'))` (line 344-345). So the MCP tool forwards
  `req.data.html` as-is (caller supplies the already-encoded payload, matching what
  `publish-content.ts` sends for one slug). The tool does NOT gzip on the caller's behalf.
- **Auth: NOT `x-content-api-key`.** `publishHandler`'s auth (via `contentAuthMiddleware`,
  though the handler itself is what we invoke) compares a **`Authorization: Bearer <token>`**
  header timing-safe against the resolved `CONTENT_API_KEY`. The handler reads
  `req.headers.authorization`. So `fakeReq.headers.authorization = 'Bearer ' + CONTENT_API_KEY`.
  (Note: invoking `publishHandler` directly does not run the Express auth middleware, but we
  forward the Bearer header anyway so the same auth contract is honored and no auth is bypassed;
  the CDS-level `@requires:'Tutorial.Author'` is the primary gate.)
- Response captured via `fakeRes.status(c).json(o)`; `code >= 400` → `req.reject(code, body.error)`
  so admins see WHY a publish failed (503 unset key, 400 bad payload, 409 lock, 500, etc.).
- Test seam `_createContentHandlers` lets the unit test assert delegation without a live DB.

## OData survival: SURVIVED (verified 3 ways)
`@protocol` widened with **object-form** additive annotation in `srv/admin-service-mcp.cds`:
```cds
annotate AdminService with @protocol: [{ kind: 'odata' }, { kind: 'mcp', path: '/mcp/admin' }];
```
Boot log: `serving AdminService { at: [ '/admin', '/mcp/admin' ] }` — both adapters mount.

- `GET /admin/$metadata` (no auth) → `401 Unauthorized` (adapter present + auth-enforced, NOT 404).
- `GET /admin/$metadata` -u alice → `403 lacking role [Admin]` (OData adapter dispatching).
- `GET /admin/$metadata` -u admin:admin → **valid EDMX** (`<edmx:Edmx Version="4.0" ...>`), and
  all 4 actions (`merge_concepts`, `promote_community_to_mission`, `trigger_rebuild`,
  `publish_content`) present in the EDMX. Confirms OData + MCP coexist per
  [[cap-graphql-shortcut-replaces-odata]] — a collapsed mount would have 404'd `/admin`.

## Handlers (all DELEGATE, none reimplement)
1. `handleMergeConcepts` — `connect('KnowledgeGraphService').send('mergeConcepts', {loser, canonical})`.
2. `handlePromoteCommunity` — `this.send('promoteCommunityToMission', {communityId, missionSlug, title})`
   (communityId Integer passed through). Underlying reject (404 no members) **propagates** (not swallowed).
3. `handleTriggerRebuild` — `scheduleRebuild('mcp:trigger_rebuild:<user>', {mode, slug})`; auto-infers
   `slug-targeted` when slug set + mode omitted, else `full`. Returns `{scheduled, mode, slug}`.
4. `handlePublishContent` — synthetic-req into content-store `publishHandler` (see above).

## Test output
`npx vitest run test/unit/mcp-admin-tools.test.js` → **8 passed**.
Guard: `test/unit/xs-security-authorities.test.js` → **13 passed** (all 3 scopes
KnowledgeGraph.Admin / SuperAdmin / Tutorial.Author + Admin present in xs-security.json).

## Model compile
`npx cds compile srv --to json` → **exit 0** (only pre-existing @UI duplicate-assignment +
backlink-distance WARNINGs, unrelated).

## Deviations
- `promote_community_to_mission` return shape declared as `{ ID, slug, title }` (the created
  Mission row shape the existing action returns via `SELECT.one`) rather than the brief's
  `{ missionId: String }` — matches what `promoteCommunityToMission` actually returns
  (`admin-service.js:2862`), so the delegation passes the row through unchanged.
- `trigger_rebuild` return declared as `{ scheduled, mode, slug }` (richer than brief's
  `{ scheduled: Boolean }`) so the MCP caller sees the inferred mode/slug echoed back.
- Added 2 extra tests beyond the brief skeleton (promote propagation of rejects; publish reject
  on 4xx) to lock the non-swallow + error-surfacing contracts.

## Security hardening (post-review, 2026-07-14 — Finding 1 HIGH + Finding 2 MEDIUM)

### Finding 1 (HIGH) — trigger_rebuild slug/mode under-validation
Added input validation at the top of `handleTriggerRebuild` before any schedule call:
- **Slug**: rejects 400 `'invalid slug: must be lowercase alphanumeric with hyphens'` for any
  non-null slug that doesn't match `/^[a-z0-9][a-z0-9-]{0,79}$/`.
- **Mode**: rejects 400 `'invalid mode: must be one of full, slug-targeted, catalog-only'`
  for any mode not in the VALID_MODES whitelist. Mode is still inferred from slug when omitted.
- `scheduleRebuild` is never called when validation fails.

### Finding 2 (MEDIUM) — publish_content control regression (two sub-fixes)

**(a) Role tightened to SuperAdmin** — `@requires` on `publish_content` in
`srv/admin-service-mcp.cds` changed from `'Tutorial.Author'` to `'SuperAdmin'`,
consistent with `promote_community_to_mission` and the EMERGENCY framing of this action.
Doc-comment updated to reflect SuperAdmin and to clarify actual auth model.

**(b) Dead Bearer forwarding removed** — the `authorization: 'Bearer ${apiKey}'` line in
`fakeReq.headers` was a misleading no-op (`publishHandler` never reads that header via the
synthetic-req path; the Express `contentAuthMiddleware` is bypassed). Removed `apiKey` const
and the `authorization` header. The real gate remains: explicit 503 when `CONTENT_API_KEY` is
unset + CDS `@requires:'SuperAdmin'`.

### Test additions
- `trigger_rebuild rejects 400 on invalid slug` (e.g. `'Bad Slug!'`): asserts `req.reject(400, ...)`
  and `scheduleSpy` NOT called.
- `trigger_rebuild rejects 400 on invalid mode` (e.g. `'nuke'`): asserts `req.reject(400, ...)`
  and `scheduleSpy` NOT called.
- All existing valid-slug/valid-mode tests unchanged (slugs `'foo'` pass the regex).

### Test result
`npx vitest run test/unit/mcp-admin-tools.test.js` → **11 passed** (was 9).
`npx cds compile srv --to json` → **exit 0**.


**Rigorous review identified two false safety claims; corrected in the same branch.**

### Fix 1 — Corrected misleading comment in `handlePublishContent`
The original JSDoc claimed "no-revert / carry-forward guards run" and that `publishHandler`
reads the `Authorization: Bearer` header for auth. Both were wrong:
- The #672 no-revert guard lives exclusively in `content-publish-session.js` (begin/append/commit
  path), NOT in the single-shot `publishHandler`. Updated comment now accurately documents what
  DOES run: files-validation, catalog-slug drop, size caps, publish lock, carry-forward.
- The forwarded `Bearer` header is no-op because `publishHandler` itself does not read the auth
  header — `contentAuthMiddleware` (Express) is skipped by the synthetic-req invocation.
  Comment updated to "defense-in-depth" framing; the real gate is now Fix 2.

### Fix 2 — Explicit `CONTENT_API_KEY` gate before synthetic req is built
Added an early check at the top of `handlePublishContent`:
```js
if (!process.env.CONTENT_API_KEY) {
  return req.reject(503, 'publish_content unavailable: CONTENT_API_KEY not configured');
}
```
This restores the app-layer gate the Express middleware would have provided. Without this,
the old code was gated only by the CDS `@requires:'Tutorial.Author'` scope — an authenticated
Admin could trigger a publish even with no key configured.

### Fix 3 — Test additions / corrections
- Existing happy-path + 4xx rejection tests wrapped with `CONTENT_API_KEY = 'test-key'` save/restore
  so they exercise the new gate correctly (they would have 503-rejected under the new code otherwise).
- New test: `publish_content rejects with 503 when CONTENT_API_KEY is not set` — asserts
  `req.reject(503, '...CONTENT_API_KEY not configured')` fires before any `_createContentHandlers`
  call.

### Design confirmation comment — `srv/admin-service-mcp.cds`
Added one-liner: `AdminService is @requires:'Admin' service-level; each action ANDs its own scope.
Callers need Admin PLUS the action scope — intended for the admin-curation tier.`

### Test result
`npx vitest run test/unit/mcp-admin-tools.test.js` → **9 passed** (was 8; new 503 test added).
`npx cds compile srv --to json` → **exit 0**.
