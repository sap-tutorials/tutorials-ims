# AEM Redirect Migration into `LegacyRedirects`

**Issue:** [sap-tutorials/tutorials-ims#752](https://github.com/sap-tutorials/tutorials-ims/issues/752) — migrate developers.sap.com redirects out of AEM so they can be maintained in tutorials-ims.
**Date:** 2026-07-24
**Status:** Design approved; pending spec review.

## Problem

The AEM export delivered so far is a single Apache `RewriteRule` file:
`D:\tmp\redirects\exportRedirectRules-dev-folder.txt`. It contains ~31 redirect
rules (plus unrelated CSP / proxy directives that are out of scope). We need to
extract the **valid** redirects and seed them into the production redirect
table so the new site preserves inbound-link and SEO continuity at cutover.

The production redirect mechanism is the CAP entity
`com.sap.developers.ims.LegacyRedirects` (`db/homepage.cds`), seeded from
`db/data/com.sap.developers.ims-LegacyRedirects.csv` and served to the approuter
via `homepage-service.js` `redirectsActive()`. The approuter refreshes the map
hourly and emits the 301/302 (`approuter/server.js`).

### The blocker: external targets are rejected by design

Commit `dd708657` (#891) added `isSameOriginPath()` to the resolver's
`buildIndex()` and a matching save-time validator in `srv/admin-service.js`.
Together they **drop / reject any redirect whose `toPath` is not a same-origin
`/…` path** — an open-redirect protection. But roughly a third of the AEM rules
point at SAP Community and other SAP sites (community.sap.com, opensource.sap.com,
help.sap.com, www.sap.com). The product requirement is explicit: **we must be
able to redirect to the SAP Community** and other trusted SAP destinations.

There is already a smoke test (`test/smoke/redirects.test.js`) asserting
`/trials-downloads.html` → `https://www.sap.com/products/try-sap/trials-downloads.html`,
but nothing implements it today — external redirects are currently unsupported.

## Goals

1. Extract every **valid** redirect from the AEM export.
2. Support **external redirects to an allowlist of trusted SAP hosts** without
   reopening the open-redirect hole #891 closed.
3. Seed the extracted rules into `LegacyRedirects` (the production table).
4. Preserve existing behavior for same-origin redirects and the 3 existing seed
   rows.

## Non-goals

- No admin-UI changes (the `LegacyRedirects` admin shell already exists, #766).
- No new redirect entity or `xs-app.json` route mechanism — one table, one path.
- Not migrating AEM mechanism 2 (`sling:redirect` per-page vanity paths) — that
  export has not been delivered (issue #752 is still `Blocked` on Riley's full
  export). This spec covers only the `RewriteRule` file we have in hand.
- No repair of malformed rules (see Excluded Rules).

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| External redirect strategy | **Allowlist external hosts** — keep the guard, permit `https:` targets whose host is on a curated SAP allowlist. |
| Same-origin targets that may not exist on the new (tutorials-only) site | **Migrate verbatim** — faithful 1:1; do not drop or retarget. |
| Malformed rule (line 30) | **Drop it, document why** — recorded below for auditability. |
| Implementation shape | **Approach A** — shared allowlist module, swap `isSameOriginPath` → `isAllowedTarget` at all gates. One admin-curated table. |

## Rule Inventory

Source targets written as `%{ENV:proto}://%{HTTP:host}/x` resolve to same-origin
`/x` (same host). All rules are 301. `[NC]` = case-insensitive (the resolver
already lowercases exact matches). Escaped `\.` → exact literal (`isPattern:false`);
alternation / capture groups → regex (`isPattern:true`).

### External (allowlisted host) — 11 rules

| # | fromPath | toPath | isPattern |
|---|---|---|---|
| 1 | `/leonardo-iot` | `https://community.sap.com/topics/leonardo` | false |
| 2 | `/topics/leonardo-iot\.html` | `https://community.sap.com/topics/leonardo` | false |
| 3 | `/open-source` | `https://opensource.sap.com/` | false |
| 4 | `^/open-source..html$` | `https://www.sap.com/about/company/innovation/open-source.html` | true |
| 5 | `^/devtoberfest..html$` | `https://community.sap.com/t5/devtoberfest/gh-p/Devtoberfest` | true |
| 6 | `/topics/s4hana-cloud-sdk.html` | `https://community.sap.com/topics/cloud-sdk` | false |
| 7 | *(country-prefix)* `s4hana-cloud-sdk.html` | `https://community.sap.com/topics/cloud-sdk` | true |
| 8 | *(country-prefix)* `s4hana-cloud-sdk.<x>.html` | `https://community.sap.com/topics/cloud-sdk#$2` | true |
| 9 | `/trials-downloads.html` | `https://www.sap.com/products/try-sap/trials-downloads.html` | false |
| 10 | `/topics/cloud-platform\.html` | `https://pages.community.sap.com/topics/business-technology-platform` | false |
| 11 | `/mobile` | `https://help.sap.com/doc/f53c64b93e5140918d676b927a3cd65b/Cloud/en-US/docs-en/index.html` | false |

**Allowlist hosts:** `community.sap.com`, `pages.community.sap.com`,
`opensource.sap.com`, `www.sap.com`, `help.sap.com`.

Rules 7 and 8 carry the long country-prefix alternation
(`africa|australia|…|westbalkans`). Rule 8 uses a `$2` capture. Both must
re-validate the substituted result against the allowlist (see Security).

### Same-origin (verbatim) — 19 rules

| # | fromPath (verbatim from file) | toPath | isPattern |
|---|---|---|---|
| 1 | `^/(de\|es\|zh)$` | `/` | true |
| 2 | `^/(de\|es\|zh)/(.*)$` | `/$2` | true |
| 3 | `^/cloud-sdk$` | `/topics/cloud-sdk.html` | false |
| 4 | `^/abap$` | `/topics/abap-platform.html` | false |
| 5 | `^/abapxml$` | `/topics/abap-platform.html` | false |
| 6 | `^/datahub$` | `/group.datahub-docker.html` | false |
| 7 | `^/tutorials/ml-fs-sapui5-series-changepoint-detection.html$` | `/group.ml-fs-api-hub.html` | false |
| 8 | `^/tutorials/ml-fs-java-series-changepoint-detection.html$` | `/group.ml-fs-api-hub.html` | false |
| 9 | `^/group.ml-fs-java.html$` | `/group.ml-fs-api-hub.html` | false |
| 10 | `^/group.ml-fs-sapui5.html$` | `/group.ml-fs-api-hub.html` | false |
| 11 | `^/ml$` | `/topics/machine-learning.html` | false |
| 12 | `^/api$` | `/topics/api.html` | false |
| 13 | `^/cloud$` | `/topics/cloud-platform.html` | false |
| 14 | `^/hanaexpress$` | `/products/hana/express-trial.html` | false |
| 15 | `^/hana-express$` | `/products/hana/express-trial.html` | false |
| 16 | `^/hana$` | `/topics/hana.html` | false |
| 17 | `^/sapui5$` | `/topics/ui5.html` | false |
| 18 | `^/ios-sdk$` | `/topics/cloud-platform-sdk-for-ios.html` | false |
| 19 | `^/webide$` | `/topics/sap-webide.html` | false |

> **Extraction note:** the exact `fromPath` regexes above (anchoring, escaping)
> are transcribed verbatim from the source file. During implementation the seed
> rows are produced by parsing the file line-by-line; this table is the
> reference. Count reconciles: **31 `RewriteRule` lines = 11 external + 19
> same-origin + 1 malformed**. The 3 existing seed rows in the CSV are left
> untouched, so 30 new rows are appended. All 6 `s4hana-cloud-sdk` variants
> redirect **externally** to community.sap.com (external rows 6–8); the
> same-origin `/cloud-sdk` short vanity (row 3 above) is a distinct rule pointing
> at the old on-site topic page — do not conflate them.
>
> **Rows 7–8 caveat:** the source uses loose dots (`.html`, `.(.*)` ) and
> unescaped `.` in several `fromPath`s (e.g. `^/group.ml-fs-java.html$`). These
> are transcribed as-is with `isPattern:true` only where the source clearly
> intends a regex (alternation or capture group); single-token vanity paths with
> incidental `.` are stored as exact literals (`isPattern:false`) to avoid
> over-broad matching. Implementation confirms each borderline case against the
> resolver's semantics.

### Excluded rules — 1

| Source (line 30) | Reason |
|---|---|
| `RewriteRule ^abap-environment-a4c-inbound-communication\|abap-environment-a4c-create-proxy\|abap-environment-a4c-create-custom-entity$  %{ENV:proto}://%{HTTP:host}https://discovery-center.cloud.sap/missiondetail/3248/3277/?tab=overview` | **Malformed.** (a) Target concatenates `%{HTTP:host}` with an absolute URL → resolves to the invalid string `developers.sap.comhttps://discovery-center.cloud.sap/…`. (b) Source regex lacks a leading `/` and the alternation is not grouped, so anchoring is wrong. **Reconstructed intent** (not applied): `^/(abap-environment-a4c-inbound-communication\|abap-environment-a4c-create-proxy\|abap-environment-a4c-create-custom-entity)$` → `https://discovery-center.cloud.sap/missiondetail/3248/3277/?tab=overview`. If re-added later, `discovery-center.cloud.sap` must be added to the allowlist. |

## Architecture (Approach A)

```
                     ┌─────────────────────────────┐
  seed CSV  ───────► │ LegacyRedirects (HANA table) │
                     └──────────────┬──────────────┘
                                    │ redirectsActive() (isActive rows)
                                    ▼
                     ┌─────────────────────────────┐
   admin edits ────► │ srv/admin-service.js gate    │  isAllowedTarget()
   (save-time)       │  (before CREATE/UPDATE/...)  │◄─┐
                     └──────────────┬──────────────┘  │
                                    │ hourly poll      │  src/lib/
                                    ▼                  │  redirect-allowlist.js
   ┌────────────────────────────────────────────┐     │  (single source of truth)
   │ approuter legacy-redirects-resolver.js      │     │
   │  buildIndex(): isAllowedTarget()  ──────────┼─────┘
   │  resolveRedirect(): re-check on $ substitute│
   └──────────────────┬─────────────────────────┘
                      │ Location: hit.toPath (verbatim — already external-capable)
                      ▼
                  301 / 302 to browser
```

### New module: `redirect-allowlist.js`

Single source of truth for the allowlist and the target-validation predicate.

```js
// Allowlist of trusted SAP hosts external redirects may target.
export const ALLOWED_HOSTS = new Set([
  'community.sap.com',
  'pages.community.sap.com',
  'opensource.sap.com',
  'www.sap.com',
  'help.sap.com',
]);

// A redirect target is allowed if it is a same-origin absolute path
// (existing #891 behavior) OR an https:// URL whose host is allowlisted.
export function isAllowedTarget(toPath) {
  if (isSameOriginPath(toPath)) return true;          // /foo, /foo?x=1
  let u;
  try { u = new URL(toPath); } catch { return false; }
  if (u.protocol !== 'https:') return false;          // no http:, javascript:, data:
  return ALLOWED_HOSTS.has(u.host);
}
```

`isSameOriginPath()` stays exactly as-is (it is still the fast path and still
independently unit-tested). `isAllowedTarget()` layers the allowlist on top.

Because the approuter and srv are separate CF app containers, the module —
like the resolver — has a **source copy in `srv/lib/`** and is **copied into
`approuter/lib/` at MTA build time** (extend the existing `before-all` `cp` in
`mta.yaml`). The resolver imports it relative to its own directory so both
copies resolve correctly.

### Gate changes (three call sites, all swap `isSameOriginPath` → `isAllowedTarget`)

1. `srv/lib/legacy-redirects-resolver.js` — `buildIndex()` drop check **and**
   the `resolveRedirect()` post-substitution re-check.
2. `approuter/lib/legacy-redirects-resolver.js` — the mirror; identical change.
3. `srv/admin-service.js` (~line 543) — save-time validator. Replace the
   inline scheme/protocol-relative/leading-slash checks with a single
   `isAllowedTarget()` call; update reject messages to
   `"toPath must be same-origin (/…) or an https URL on an allowlisted SAP host"`.

### Location emission — no change

`approuter/server.js:74` already sets `Location: hit.toPath` verbatim, so an
absolute `https://…` target is emitted correctly once the resolver stops
dropping it.

### Seed data

Append the 30 valid rows to
`db/data/com.sap.developers.ims-LegacyRedirects.csv`, keeping the 3 existing
seed rows. Use deterministic UUIDs continuing the existing
`66333900-1eaa-0001-0001-0000000000NN` scheme (matches the project's
deterministic-UUID convention for seed data). Set `statusCode=301`,
`isActive=true`; `isPattern` per the tables above.

## Security

The open-redirect protection is **preserved, not removed**:

- Non-allowlisted external hosts are still dropped at build time and rejected at
  save time.
- `http:`, `javascript:`, `data:`, `mailto:`, protocol-relative `//host` targets
  are all still rejected (only `https:` + allowlisted host passes the external
  branch).
- The #891 capture-group smuggling defense stays: after `$1/$2` substitution in
  `resolveRedirect()`, the result is re-validated with `isAllowedTarget()`, so a
  crafted inbound URL cannot turn a benign pattern target into an off-allowlist
  redirect.
- Adding a new external destination is a deliberate one-line edit to
  `ALLOWED_HOSTS`, reviewed in PR — admins cannot introduce arbitrary external
  targets through the admin UI.

## Testing

- **Unit** (`test/unit/legacy-redirects-resolver.test.js`, both concerns):
  - `isAllowedTarget('/foo')` → true; `('https://community.sap.com/x')` → true;
    `('https://attacker.example/x')` → false; `('http://community.sap.com')` → false
    (not https); `('//community.sap.com')` → false.
  - `buildIndex` keeps an allowlisted external row and still drops a
    non-allowlisted one.
  - Pattern substitution cannot smuggle a non-allowlisted host via `$1`.
- **Save-validator test** — allowlisted external `toPath` accepted; arbitrary
  external rejected with the new message.
- **Smoke** (`test/smoke/redirects.test.js`) — the existing
  `/trials-downloads.html` external assertion now has backing seed data;
  add a same-origin case (e.g. `/abap`) and one more external case
  (e.g. `/leonardo-iot` → community.sap.com).
- Keep the mirror check green: after editing the srv copy, re-run the `cp`
  (or `mbt build`) so the approuter copy stays in sync.

## Open questions / follow-ups

- **AEM mechanism 2** (per-page `sling:redirect` vanity paths) is still awaited
  in issue #752 and is out of scope here; a follow-up migration will handle it
  when Riley delivers that export.
- Several same-origin targets (`/topics/*.html`, `/products/*.html`,
  `/group.*.html`) point at pages that may not exist on the tutorials-only site.
  Migrated verbatim per decision; flagged here so a future pass can retarget them
  to SAP Community equivalents if 301→404 chains show up in logs post-cutover.
