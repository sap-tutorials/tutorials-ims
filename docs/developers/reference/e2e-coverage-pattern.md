# e2e coverage pattern — UI change → committed e2e spec

## Why this exists

Features are built by one agent per PR, but consolidated deploys run later via
a separate agent. The author's knowledge of "how do I know this works" is lost
at the handoff. #1371 is the canonical failure: PR #1353 replaced the native
Fiori value help on the Missions path-item tutorial field with a custom dialog;
PR #1366 (a day later) widened the *native* value help that #1353 had stopped
using — so #1366 was dead code on that field. Every gate passed (#1353's unit
test was a static grep, #1366's CDS compiled, the bundle gate confirmed bytes
shipped, smoke didn't open the picker). Nobody caught it until a human tried to
use it in PROD.

**Root pattern:** every gate checked "did the artifact deploy," never "does the
feature work for a user." A per-PR unit test cannot catch a cross-PR seam; only
a committed e2e spec that drives the deployed UI can.

## The pattern

1. **When you change user-facing UI** (`app/admin/**`, `app/**/webapp/**`,
   `hugo/layouts/**`, `hugo-apps/**`), add or update an e2e spec under
   `test/e2e/` that exercises the changed surface against the *deployed* env.
2. A **PR advisory check** (`.github/workflows/e2e-coverage-nudge.yml`) reminds
   you if you changed UI without touching `test/e2e/`. It is **advisory — it
   never blocks merge** (a hard gate would just breed no-op specs).
3. The **existing post-DEV-deploy e2e CI job** (`deploy.yml` job `e2e`,
   `needs: [deploy, smoke-test]`) runs the `test/e2e/` specs against the
   deployed DEV env. That job — not the nudge — is where coverage is actually
   proven, because the specs drive the real UI.

## Writing an e2e spec

- Templates: the existing specs in `test/e2e/` (`admin-shell.test.js`,
  `tutorial-serve.test.js`, …) and `test/e2e/README.md`.
- Specs **self-skip** when `SMOKE_BASE_URL` / credentials are absent
  (`describe.skipIf(!hasBaseUrl() || !hasCredentials())`), so `npm test` is
  never affected — they only run post-deploy where those env vars are set.
- Auth uses `SMOKE_TECH_USER` / `SMOKE_TECH_PASSWORD` via the approuter.
- Assert on **observable behavior**, not code shape: e.g. open a control, assert
  the rendered columns/rows a user sees. (A static string check of the source
  is what let #1366 through.)

## PROD

PROD deploy is unchanged: blue-green + smoke. The operator confirms DEV e2e is
green before promoting to PROD. There is no automated DEV→PROD e2e coupling by
design (avoids brittle cross-env status-plumbing).

## Not covered yet (follow-ups)

- A concrete e2e spec for the Missions path-item picker (#1371 flow: open the
  Task value help → assert Title/Slug/Tag/Legacy ID columns → slug search finds
  a known row like `cp-aibus-dox-*`).
- Backfill for other critical admin flows.
