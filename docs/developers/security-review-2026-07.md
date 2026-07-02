# Security review — July 2026

> Comprehensive audit of the tutorials-ims (a.k.a. tutorials-poc) codebase, run against `main` at commit `662da3e8` on 2026-07-01. Parent tracking issue: [#808](https://github.com/sap-tutorials/tutorials-ims/issues/808).

This review is the quarterly cadence item promised by #808. It is **not** a formal penetration test — it is a code-and-config audit conducted by reading every service, every custom Express route, every workflow, and every anonymous surface. A separate pen-test is still required before the PROD cutover (end-July 2026).

## Scope

- All CDS services and their handlers under `srv/`
- The AppRouter (`approuter/server.js`, `approuter/xs-app.json`, `approuter/lib/`)
- All GitHub Actions workflows under `.github/workflows/`
- Deployment descriptors (`.deploy/mta.yaml`, `deploy/*.mtaext`, `xs-security.json`)
- Anonymous entry points (routes with `authenticationType: 'none'` or services with `@requires: 'any'`)
- Injection surfaces (SQL, HTML, YAML, command execution, template rendering)
- Secrets handling (envsubst chain, credstore path, hardcoded tokens)
- The frontend islands (`hugo-apps/`, `app/*/`) for stored-XSS ingress paths

Explicit exclusions: dependency-audit style CVE reporting (managed separately via Dependabot / `npm audit`), DoS/resource-exhaustion (per audit criteria), and any code paths that only run in `test/` fixtures.

## Methodology

Eight parallel investigators, each with a scoped attack surface, produced ~55 raw findings. Every candidate then went through an adversarial verification pass — a separate reviewer asked to try to *refute* it — before landing here. Roughly two-thirds of the raw findings were dismissed as either false positives, defense-in-depth-only, or already mitigated. What remains are the 11 issues that survived verification and were filed as GitHub issues.

## Summary

| Severity | Count | Issues |
|---|---|---|
| **HIGH** | 4 | [#887](https://github.com/sap-tutorials/tutorials-ims/issues/887), [#888](https://github.com/sap-tutorials/tutorials-ims/issues/888), [#889](https://github.com/sap-tutorials/tutorials-ims/issues/889), [#890](https://github.com/sap-tutorials/tutorials-ims/issues/890) |
| **MEDIUM** | 5 | [#891](https://github.com/sap-tutorials/tutorials-ims/issues/891), [#892](https://github.com/sap-tutorials/tutorials-ims/issues/892), [#893](https://github.com/sap-tutorials/tutorials-ims/issues/893), [#894](https://github.com/sap-tutorials/tutorials-ims/issues/894), [#895](https://github.com/sap-tutorials/tutorials-ims/issues/895) |
| **LOW / hardening** | 3 | [#896](https://github.com/sap-tutorials/tutorials-ims/issues/896)/[#897](https://github.com/sap-tutorials/tutorials-ims/issues/897), [#898](https://github.com/sap-tutorials/tutorials-ims/issues/898), [#899](https://github.com/sap-tutorials/tutorials-ims/issues/899)/[#900](https://github.com/sap-tutorials/tutorials-ims/issues/900) |

Note on the numbering: #896 and #897 are both MEDIUM but grouped under the "auth-scope broadening" theme in the LOW/hardening block for planning purposes below. The individual issues carry the correct severity.

## HIGH findings

### #887 — DEV `CONTENT_API_KEY` committed to repo and published docs site

The DEV publish-token value (a short well-known ASCII string, redacted here per #887 fix) was previously embedded in:

- [CLAUDE.md:95](../../CLAUDE.md#L95), [CLAUDE.md:130](../../CLAUDE.md#L130)
- [deploy/dev.mtaext](../../deploy/dev.mtaext) — literal, not a `${...}` placeholder
- Multiple developer docs (`docs/developers/architecture/authentication.md`, `docs/developers/operations/mta-deployment.md`, `docs/developers/operations/re-migration-runbook.md`, `docs/developers/reference/ai-consumption.md`)
- Every `docs/superpowers/plans/*.md` that ever mentioned publish testing
- `srv/data/admin-docs-index.json` (indexed for the in-app admin help)
- `scripts/cutover-rehearsal.cjs`
- The built VitePress site under `docs/.vitepress/dist/` — deployed to <https://sap-tutorials.github.io/tutorials-ims/>

Anyone reading the public docs page gets a working DEV publish token. That's enough to replace tutorial HTML in DEV — a stored-XSS pivot across every visitor of the DEV tutorial pages. PROD is safe (uses the `${CONTENT_API_KEY}` placeholder in `prod.mtaext` resolved from env/credstore at deploy time), but the pattern is fragile — one accidental copy-paste and the same string becomes the PROD key.

**Fix summary:** rotate the DEV key; move `deploy/dev.mtaext` to placeholder form; scrub every doc + rebuilt Pages site; add a secret-scanning rule (`gitleaks` in CI) that fails on the literal string.

### #888 — SSRF in AppRouter `img-cdn` — `fetch()` follows 3xx redirects

[approuter/server.js:135](../../approuter/server.js#L135) validates the initial URL's hostname against `IMG_CDN_HOSTS = ['raw.githubusercontent.com']` but calls global `fetch()` with default redirect behavior, so a controlled upstream 302 can pivot the request to any host — including link-local metadata services (`169.254.169.254`) and internal CF Gorouter targets.

GitHub itself is unlikely to open-redirect from `raw.githubusercontent.com` today, but the pattern is a footgun: every future host added to the allowlist reopens the window.

**Fix summary:** pass `redirect: 'manual'`, manually handle 3xx by re-validating the hostname per hop, and add a private-IP block on the resolved target.

### #889 — ScannerService `claimPrize` has no ownership check (IDOR)

[srv/scanner-service.js:70-88](../../srv/scanner-service.js#L70-L88) flips any `PrizeRecords.status` to `CLAIMED` given the row's `legacyId`. The service is gated by `@requires: 'authenticated-user'` and the approuter route requires the `MobileApp` scope, but that scope is shared across all event staff — a rogue or compromised staff account can claim any prize.

Combined with predictable integer `legacyId`s, this becomes systemic prize fraud during the event.

**Fix summary:** thread the contestant's `imsId` (already carried in the QR the scanner just processed) through to the action, and reject unless `PrizeRecords.user_ID` matches. Emit an audit event on every claim.

### #890 — AuthorService `rebuildContent` has no ownership check (IDOR)

[srv/author-service.js:52-60](../../srv/author-service.js#L52-L60) forwards straight to `handleRebuildAction` without checking that the caller owns the tutorial being rebuilt. Any user with the `Tutorial.Author` scope can trigger rebuilds against anyone else's tutorial.

Ironically the same file *already defines* `assertOwnership()` and uses it elsewhere — it just wasn't wired into this handler.

**Fix summary:** two-line patch — call `assertOwnership(req.params[0], req.user)` at the top of the handler and 403 on false.

## MEDIUM findings

### #891 — Open redirect via admin-editable `LegacyRedirects.toPath`

[approuter/server.js:70-77](../../approuter/server.js#L70-L77) writes redirect targets straight to the `Location:` header with no same-origin check. The redirect table is admin-editable via `AdminService`. A compromised admin (or a chained lower-severity vuln that lets an attacker persist a row) sets `toPath: 'https://attacker.example/phish'` on a well-known slug like `/tutorial/foo`, and every visitor gets 301'd to a phishing page under the trusted `developers.sap.com` origin. The 24-hour `Cache-Control: public, max-age=86400` on the response makes takedown slow.

Also related: [approuter/lib/legacy-redirects-resolver.js:29](../../approuter/lib/legacy-redirects-resolver.js#L29) compiles admin-supplied regex with `new RegExp(row.fromPath)` — no ReDoS defense.

### #892 — Local-dev mock auth in AppRouter only gated by absence of `VCAP_APPLICATION`

[approuter/server.js:406-410](../../approuter/server.js#L406-L410) injects hardcoded Basic auth (`admin:admin`, `developer:developer`, `display:display`) into upstream requests whenever `isLocal === true`, and `isLocal = !process.env.VCAP_APPLICATION`. If a CF deploy misfires and `VCAP_APPLICATION` is unset, the AppRouter silently switches to mock-auth mode in production — anyone hitting `/admin/` gets Admin.

Requires a positive `NODE_ENV === 'development'` gate (and ideally a boot-time refusal to start when `NODE_ENV` and `VCAP_APPLICATION` disagree).

### #893 — Feedback comment stored without HTML sanitization

`/feedback/submit` accepts anonymous submissions where `comment` is stripped of nulls and control chars but not HTML. Rows surface in the admin Feedback Fiori app at `/admin-ui/#feedback-display`. If any renderer path treats `comment` as HTML (Fiori Elements can be coaxed into it), an anonymous attacker's `<img src=x onerror=…>` runs in an authenticated admin's browser — the classic low-privilege-input, high-privilege-renderer XSS pivot. Compounded by CSP `unsafe-inline` (see #896).

### #894 — CSRF protection disabled on every XSUAA route in `xs-app.json`

Every mutating route sets `csrfProtection: false` — including `/admin/*`, `/scanner/*`, `/author/*`, `/api/*`, `/chat/*`, `/graph/*`, `/_dev/*`, `/display/*`. Modern browsers with `SameSite=Lax` cookies neutralize most drive-by CSRF, but that's a defense-in-depth we shouldn't be relying on. The AppRouter's built-in `x-csrf-token` mechanism costs nothing to re-enable — Fiori/OData clients already fetch the token via `x-csrf-token: fetch`.

### #895 — SSRF via admin-controlled RSS + learning-journey fetchers

Two server-side fetchers pull URLs from admin-managed DB entities (`HomepageShelves.url`, `LearningJourneys.url`) without allowlist or private-IP guard. Files: [srv/lib/homepage-rss-fetcher.js:89-98](../../srv/lib/homepage-rss-fetcher.js#L89) and [srv/lib/learning-journey-body-fetcher.js:33-94](../../srv/lib/learning-journey-body-fetcher.js#L33). An admin (or chained-vuln pivot to admin-write) sets `url` to `http://169.254.169.254/…` and the CAP srv fetches it under its own identity.

## LOW / hardening findings

### #896 — CSP `unsafe-inline`, missing HSTS / X-Frame-Options / Permissions-Policy

`script-src 'unsafe-inline' ...` on the AppRouter CSP header neuters CSP's XSS defense. Migrate to nonce-based CSP (report-only rollout first). Also add HSTS, X-Frame-Options, and Permissions-Policy while we're editing the header.

### #897 — EventStreamService is anonymous and broadcasts `userName` in `tutorialCompleted` events

[srv/event-stream-service.cds](../../srv/event-stream-service.cds) is `@requires: 'any'` and its `tutorialCompleted` event carries `userName`. Approuter routes `/ws/*` and `/socket.io/*` are `authenticationType: 'none'`. Anyone on the internet can subscribe and receive live PII on every tutorial completion. GDPR concern. Either drop `userName` from the payload (rebuild downstream leaderboards from authenticated queries) or require auth.

Filed as MEDIUM in the tracker but included here in the hardening block for planning purposes.

### #898 — DeveloperService `submitTutorialFeedback` is `@requires: 'any'`

Cross-references #893. Anonymous DB writes are a known bad pattern even with rate-limit + honeypot. If keeping anonymous (product intent), at minimum: validate `tutorialSlug` exists, add a Turnstile/hCaptcha challenge for high-volume patterns, and audit-log every submission by IP-hash.

### #899 — tar extraction in `/admin/rebuild` needs explicit `strict: true` + symlink filter

[approuter/server.js:260-266](../../approuter/server.js#L260-L266) — the current `filter` blocks path-traversal but not symlink-based escape. Node `tar` v7 is safer by default than v6, but pinning defensive flags explicitly (`strict: true`, filter out `SymbolicLink`/`Link` entry types) prevents regression on any future tar bump. Exploit requires the `REBUILD_API_KEY` PAT to leak, so low real-world risk.

### #900 — `js-yaml.load` without `CORE_SCHEMA` in api-docs seeder/job

[srv/lib/seed-api-docs.js:16](../../srv/lib/seed-api-docs.js#L16) and [srv/jobs/fetch-api-docs-job.js:54](../../srv/jobs/fetch-api-docs-job.js#L54). Currently safe because the YAML source is version-controlled, but the pattern is a landmine if either call site is ever refactored to consume HTTP-fetched or user-authored YAML. Cheap fix: switch to `CORE_SCHEMA` project-wide + add an ESLint rule.

## Things that were audited and passed

Recording these so the next reviewer knows what's already been checked:

- **`isAuthorizedBearer` in `approuter/lib/bearer-auth.js`** — correct constant-time compare via `crypto.timingSafeEqual` with length-equal guard. Same pattern replicated in `srv/lib/content-store.js`.
- **`secret-resolver.js` and `credstore-secret.js`** — credstore-first with 5-min TTL cache; strict alias regex prevents path traversal; mTLS + JWE encryption on payload; explicit `AbortSignal.timeout`; env fallback only when credstore is unreachable, never for defaulting.
- **Advocate photo upload** — memoryStorage multer, 5 MB hard limit, MIME allowlist + magic-number validation via `sharp`, animated GIF rejection, WebP re-encoding. No path traversal, no XXE, no zip-bomb path.
- **Analytics `runSelectQuery`** — Admin-only; `node-sql-parser` AST-validated with a strict function allowlist, comment stripping, single-statement enforcement, and table allowlist derived from `@analytics.exposed` annotations. LIMIT 5001 wrapper. Query results never leave Admin context.
- **JWT / cookies** — no `jwt.decode` without verify; no custom JWT signing; XSUAA session cookies are framework-managed by `@sap/approuter`.
- **Chat / Joule tools** — user-scope isolated (isAdmin gate on tools); system prompt is not user-controllable; harm from prompt injection is bounded to the caller's own context.
- **KnowledgeGraphService write path** — anonymous read is deliberate, but writes are gated by an OData `Capabilities.InsertRestrictions/DeleteRestrictions` + a before-UPDATE hook that asserts `KnowledgeGraph.Admin`. Two independent layers.
- **Content GC + rollback** — protected by bearer token; rollback logic can't restore a manifest older than the retention window.
- **`login-redirect.html`** — the `returnTo` handling correctly rejects protocol-relative (`//`), absolute, and non-slash-prefixed values. Well-designed.

## Themes and follow-ups

Several of the findings share underlying causes worth tracking as themes:

1. **Ownership-check gap on Fiori actions.** #889 and #890 are the same class of bug: an authorization *scope* is treated as sufficient when the action is really per-object. The same code review pattern would help — the `assertOwnership` helper already exists in `srv/author-service.js` and should be lifted to `srv/lib/` and applied wherever a scope covers multiple entity owners.
2. **`authenticationType: 'none'` + DB write.** #893, #895, #897, #898 all involve state-changing operations reachable without authentication. Each has a story ("feedback shouldn't need login", "GitHub-Actions publishes need a static token", etc.), but adding a checklist item to PR review — *any new anonymous mutating route requires explicit sign-off* — would prevent the next one.
3. **Secrets in docs.** #887 is the surface, but the root cause is that `deploy/dev.mtaext` uses literal values instead of placeholders, and doc examples copy that literal. Fixing #887 without adding secret-scanning to CI leaves the door open.

## Next actions

The four HIGHs are the P0 backlog for this quarter. #887 in particular should be rotated **before** doing anything else, because the exposed key is public *right now*.

The five MEDIUMs are P1 for the July–September quarter, ideally landed before the end-July PROD cutover — CSRF re-enablement (#894) and the SSRF class (#888, #895) are particularly important pre-cutover.

The three LOW/hardening items and one MEDIUM (#897) are the P2 hardening backlog for Q3 2026. #896 (CSP nonce migration) is the largest of these — treat it as its own multi-PR initiative.

A pen-test engagement against the deployed PROD infrastructure is still recommended before the July cutover, per the parent issue #808. This code-and-config audit does not substitute for it.
