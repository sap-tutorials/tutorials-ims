---
title: SAP Discovery Center integration
description: The legacy-compatible `.model.json` endpoint that SAP Discovery Center consumes to render tutorial cards, plus the modern `/build/repo-catalog` alternative.
---

# SAP Discovery Center integration

> Status: rebuilt in PR #1685 (2026-08-12). **Open contract question** with the DC
> team — see [Open questions](#open-questions) before trusting in PROD.

## What this is

SAP Discovery Center (`discovery-center.cloud.sap`) embeds tutorial cards that
link out to `developers.sap.com` tutorials. To render a card, DC needs the
**GitHub source repo** of the tutorial — it loads and renders the tutorial
content from GitHub, not from our site.

Under the old Adobe Experience Manager (AEM) frontend, DC obtained that link by
fetching a per-tutorial AEM Sling Model export:

```
https://developers.sap.com/tutorials/<slug>.model.json
```

AEM was decommissioned at PROD cutover (2026-08-09), so that path 404'd and DC's
tutorial cards stopped rendering. This integration **rebuilds the same
`.model.json` envelope from our own data** so DC continues to work with zero
changes on its side (Option A). A DC-side alternative also exists
([`/build/repo-catalog`](#alternative-buildrepo-catalog)).

Why this was missed at migration: the AEM gap analysis
(`docs/historic/aem-gap-analysis.md` §E14) closed "Crawlable JSON Endpoints" on
the assumption that Akamai 403'd all JSON for public crawlers, so nothing
consumed them. DC was Akamai-**allowlisted** (public `curl` still 403s today), so
it was the one consumer that survived — flagged as an unchased concern (Open
Question #5) but never linked to `.model.json` consumption. The schema itself was
never captured because the live endpoint always 403'd crawlers; it was recovered
from a 2023 Wayback Machine snapshot.

## Request path

DC calls the same public URL it always has. The chain to our CAP handler:

```
DC  →  GET https://developers.sap.com/tutorials/<slug>.model.json
        │  (Akamai — DC is allowlisted; anonymous curl is 403'd at the edge)
        ▼
     approuter route  (approuter/xs-app.json)
        source:  ^/tutorials/(.+)\.model\.json(\?.*)?$
        target:  /content/tutorial-model/$1$2
        dest:    srv-api        authenticationType: none
        ▼
     CAP  GET /content/tutorial-model/*slug   (srv/server.js:450)
        handler: modelJsonHandler   (srv/lib/model-json-handler.js)
        envelope builder: buildModelJson   (srv/lib/model-json.js — pure, no DB)
```

The route is **unauthenticated** (`authenticationType: none`) — the legacy export
was public, and the payload is metadata already public on GitHub. The srv-api
route pattern in `xs-app.json` includes the `(\?.*)?$` query group so
`?<cachebuster>` requests are not 404'd (see the `approuter-build-route-needs-query-string-group` gotcha).

## Endpoint contract

| | |
| --- | --- |
| **Public URL** | `GET /tutorials/<slug>.model.json` |
| **Internal URL** | `GET /content/tutorial-model/<slug>` |
| **Auth** | None (public) |
| **Success** | `200` `application/json; charset=utf-8`, `Cache-Control: public, max-age=300`, `X-Content-Source: db` |
| **Mixed-case slug** | `301` → `/tutorials/<lowercase-slug>.model.json` (query preserved) |
| **Redirected tutorial** | `301` → target slug's `.model.json` (admin rename/redirect via `redirectTo_ID`) |
| **Unknown / invalid slug** | `404` `{ "error": "Tutorial not found: <slug>" }` |
| **Build error** | `500` `{ "error": "model.json build failed" }` |

Slugs are lowercase-canonical (`^[a-z0-9][a-z0-9-]*$`); a stray
`.html` / `.json` / `.model.json` suffix on the captured slug is stripped before
lookup.

## Response shape — the field DC parses

The response reproduces the deep AEM Sling Model tree. **DC only needs one
field**: the GitHub link, which the legacy export placed inside the feedback
"Contribute suggestion" button. It lives at exactly one location:

```jsonc
// JSONPath from the root of the .model.json document:
$[':items'].par[':items'].par1[':items'].contentParsys
  .buttonBar.feedbackModel.options[ linkType == "github" ].href
```

That `href` is a GitHub *issue-creation* URL:

```
https://github.com/<owner>/<repo>/issues/new?title=<title>&body=Tutorials:%20https://developers.sap.com/tutorials/<slug>.html%0A...
```

**DC regexes the `<owner>/<repo>` out of that issue URL.** Preserving the exact
location and href shape of this `options[]` entry is the load-bearing part of the
compatibility contract — everything else in the envelope is scaffolding for
byte-shape parity.

The `feedbackModel.options` array is built in this order:

1. `community` (static — "Ask the community")
2. `github` (dynamic — **present only when RepoCatalog has a `repo` for the slug**)
3. `survey` (static — "Take our survey")

> If a slug has no RepoCatalog entry, the `github` option is **omitted** (the
> array still has community + survey). A DC card for such a tutorial will not find
> a repo — treat a missing `github` option as "unknown repo", not an error.

Other populated metadata: `title`, `description`, `tags` (as a
`{ label: titlePath }` map), `tutorialDescription.contributors`
(creator / owner / collaborators), `proficiency`, `time`, `imsId` (legacyId), and
the `technicalFields.metadata` OG/Twitter block.

## Data sources

`modelJsonHandler` hydrates the envelope from these entities
(`com.sap.developers.ims`):

| Field group | Source entity | Notes |
| --- | --- | --- |
| Core metadata | `Tutorials` | title, description, legacyId, experienceTag, primaryTag, averageTimeToComplete, status, `redirectTo_ID` |
| `github` option owner/repo/branch | `RepoCatalog` (`payload` JSON) | Same source the admin tutorial-links use (`srv/lib/tutorial-links.js`). Fail-quiet: a catalog miss just drops the github option |
| `tags` | `TutorialTags` → `Tags` | `{ label, titlePath }` |
| `contributors` | `TutorialContributors` → `Users` | login resolved via `Users.githubLogin` |

## What is intentionally NOT reproduced

- **`tutorialBody.steps[]` rendered HTML** — the shape is kept (`{ intro: '', steps: [] }`)
  so consumers reading `.tutorialBody.steps` get an array, not `undefined`, but the
  steps are empty. DC renders tutorial content from GitHub via the repo link; we do
  not persist structured per-step HTML server-side (`Steps` stores only `stepOrder`
  + `contentHash`).
- Author/edit-mode chrome, live prerequisites/"you will learn" rich text — emitted
  as empty scaffolding to match the shape.

## Alternative: `/build/repo-catalog`

If the DC team prefers a purpose-built, non-legacy contract over the AEM envelope,
we already expose the catalog directly (Option B — requires a DC-side change):

```
GET /build/repo-catalog        (unauthenticated)
→ { "<slug>": { owner, repo, branch, visibility, defaultLang, topics }, ... }
```

Handler: `srv/lib/repo-catalog.js` (`repoCatalogReadHandler`); route
`approuter/xs-app.json` `^/build/(...|repo-catalog|...)`. This is the cleaner
long-term integration (no AEM-shaped scaffolding), but switching to it is a
cross-team change DC must make; the `.model.json` shim exists so DC keeps working
in the meantime.

## Open questions

1. **The recovered schema sample is from 2023.** Confirm with the DC team which
   field they actually parse today, and get a *current* payload sample, before
   trusting the shim in PROD. The GitHub-link location above is our best
   reconstruction from the Wayback snapshot + code.
2. **Long-term direction:** does DC want to keep the `.model.json` shim indefinitely,
   or migrate to `/build/repo-catalog`? The shim carries AEM scaffolding we would
   otherwise be free to drop.

## Related code & tests

- Builder (pure): `srv/lib/model-json.js`
- Handler (DB hydration): `srv/lib/model-json-handler.js`
- Route registration: `srv/server.js:450`
- Approuter route: `approuter/xs-app.json` (`^/tutorials/(.+)\.model\.json(\?.*)?$`)
- Catalog handler: `srv/lib/repo-catalog.js`
- Recovered legacy fixture: `srv/lib/__tests__/fixtures/legacy-abap-create-project.model.json`
- Unit tests: `srv/lib/__tests__/model-json.test.js`, `srv/__tests__/lib/model-json-route.test.js`
