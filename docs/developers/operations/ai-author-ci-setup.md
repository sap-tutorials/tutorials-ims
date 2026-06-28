# AI authoring CI setup (#208 spike → #312 graduation)

> **Status:** required setup for `rebuild-content.yml` and
> `rebuild-content-qa.yml`. AI-quiz authoring is **always-on** as of
> [#312](https://github.com/sap-tutorials/tutorials-ims/issues/312) (2026-06-27 — soak window completed clean).
> See [issue #208](https://github.com/sap-tutorials/tutorials-ims/issues/208) for the spike's vision,
> [issue #275](https://github.com/sap-tutorials/tutorials-ims/issues/275) for graduation, and
> [issue #312](https://github.com/sap-tutorials/tutorials-ims/issues/312) for the flag-removal.

## Why this exists

The AI-quiz pipeline runs in `scripts/fetch-tutorials.ts` — a
build-time pipeline. The deployed `tutorials-srv` app does NOT run
fetch-tutorials, so `cf set-env tutorials-srv …` would have no effect.
The only places fetch-tutorials runs are:

1. **Locally** under `cds bind --exec` (the pilot-1 path used by [project_208_spike_pilot_1.md](../../superpowers/specs/2026-06-05-208-ai-authored-quizzes-design.md) — see PR #261 + #277).
2. **In CI** via `rebuild-content.yml` / `rebuild-content-qa.yml`, the workflows authors trigger to rebuild
   tutorial content end-to-end.

This runbook covers (2) — the CI authoring path.

## What CI needs

`srv/lib/ai-quiz-llm.js` (PR #261) reads `ChatSettings` with three
fallback paths in priority order:

1. `cds.entities('com.sap.developers.ims').ChatSettings` (deployed CAP runtime — not available in CI).
2. Raw SQL via `cds.connect.to('db')` (requires HANA service binding — not available in CI either).
3. Env-var defaults: `CHAT_MODEL_NAME`, `CHAT_DEPLOYMENT_ID`.

For CI we use path 3, plus a `VCAP_SERVICES` env that carries the
`tutorials-aicore` service binding (read by `@sap-ai-sdk/orchestration`
to authenticate against the SAP AI Hub).

That means **two GitHub secrets** to set up + a **one-line PR per
pilot tutorial** in its `*-Contribution` repo.

## One-time setup (Tom only)

### 1. Rotate the aicore service key

If the `tutorials-dev` key was ever printed to a terminal during
debugging, treat it as compromised. Rotate before going further:

```bash
cf delete-service-key tutorials-aicore tutorials-dev
cf create-service-key tutorials-aicore tutorials-dev
```

### 2. Capture the credentials JSON

```bash
cf service-key tutorials-aicore tutorials-dev > /tmp/aicore-key.json
```

The file looks like:

```json
{
  "credentials": {
    "appname": "...",
    "clientid": "...",
    "clientsecret": "...",
    "credential-type": "binding-secret",
    "identityzone": "...",
    "identityzoneid": "...",
    "serviceurls": { "AI_API_URL": "..." },
    "token-type": ["xsuaa"],
    "url": "..."
  }
}
```

The GitHub secret holds **only the inner `credentials` block** — the
workflow wraps it in the outer `aicore[]` structure when constructing
`VCAP_SERVICES`.

Extract the credentials block:

```bash
jq '.credentials' /tmp/aicore-key.json > /tmp/aicore-creds.json
```

### 3. Set the GitHub secrets

```bash
# The aicore credentials JSON (inner block only)
gh secret set AI_AUTHOR_AICORE_SERVICE_KEY < /tmp/aicore-creds.json

# The orchestration deployment ID (read from `ChatSettings` row on DEV).
# Live value as of 2026-06-06: da6d9c5e3fb50c3d. If `ChatSettings.DEPLOYMENTID`
# changes (rare — only on aicore deployment swap), update this secret too.
echo "da6d9c5e3fb50c3d" | gh secret set CHAT_DEPLOYMENT_ID
```

### 4. Wipe the local copies

```bash
rm /tmp/aicore-key.json /tmp/aicore-creds.json
```

### 5. (Optional but recommended) Set the model name secret too

When `ChatSettings.MODELNAME` is `null` (the current state on DEV),
`srv/lib/ai-quiz-llm.js` falls back through `process.env.CHAT_MODEL_NAME`
to a hardcoded `'anthropic--claude-4.6-sonnet'`. If you want CI to use
a specific model without touching the runtime DB, set:

```bash
echo "anthropic--claude-4.6-sonnet" | gh secret set CHAT_MODEL_NAME
```

Then add `CHAT_MODEL_NAME: ${{ secrets.CHAT_MODEL_NAME }}` to the
`Fetch tutorials` step's env block. (Not done by default — the
hardcoded fallback is the same string today.)

## Per-pilot setup (any author)

To get AI questions to actually generate for a tutorial, the directive
must be in the upstream `*-Contribution` repo's `rules.vr`. Worktree-local
edits to `.tutorial-cache/<slug>.rules.vr` work for ad-hoc local seeding
but get wiped on every CI rebuild (the cache is rebuilt from the upstream
repo).

For each pilot tutorial:

1. Find the matching `*-Contribution` repo. Naming convention: the
   tutorial's source repo + `-Contribution` (e.g.
   `abap-core-development` → `abap-core-development-Contribution`).
2. Locate `tutorials/<slug>/rules.vr` in that repo. Create one if it
   doesn't exist.
3. Add `[AUTOAUTHOR_ALL]` (or per-step `[AUTOAUTHOR_N]`) on its own line.
   Existing `[VALIDATE_N]` blocks always win — they override AI for
   that step.
4. Open a PR. Once merged, the next CI rebuild will generate AI
   questions for every step that doesn't have hand-authored content.

## Triggering an AI-author rebuild

After the secrets are set up + at least one pilot has a directive,
AI authoring runs on every non-`catalog-only` rebuild. To trigger one
manually:

```bash
gh workflow run rebuild-content.yml \
  --ref main \
  -f environment=dev \
  -f ai-author-build-cap=200
```

For a single-tutorial test:

```bash
gh workflow run rebuild-content.yml \
  --ref main \
  -f environment=dev \
  -f slug=abap-cloud-ui-from-interface \
  -f ai-author-build-cap=20
```

For the QA channel:

```bash
gh workflow run rebuild-content-qa.yml \
  --ref main \
  -f ai-author-build-cap=200
```

## Cost expectations

- Per-call: ~$0.005–0.012 (Claude 4.6 Sonnet at orchestration prices).
- Default cap of 200 calls = ~$1–$2.40 per full rebuild with the flag on.
- First-time bulk seed (10000 cap) on the full ~1,400-tutorial catalog:
  expect ~$50–$100 in LLM calls, but that assumes most tutorials have
  AUTOAUTHOR directives. If only a handful do, cost is bounded by the
  number of pilot tutorials × ~$0.05–$0.15 each.

## What gets shipped to DEV

When a rebuild succeeds:

1. Each tutorial with `[AUTOAUTHOR_*]` in upstream rules.vr gets AI
   questions generated for steps that lack hand-authored validates
   (precedence: hand-authored always wins, see PR #277).
2. AI questions land in `.tutorial-cache/<slug>.ai-quiz-cache.json`
   (CI workspace; gets wiped after the run).
3. Hugo build emits the AI questions into per-tutorial frontmatter.
4. `publish-content` uploads the rendered HTML to HANA.
5. AI-authored text questions also flow through the existing
   `validate-answer-spec` sidecar (PR #260's `populateAiAuthoredSiblingMaps`)
   so `/api/validate-answer` can grade them at runtime.

The validation widget (PR #226) renders AI questions identically to
hand-authored ones — there's no special UI for "this is AI-authored."
The eval CSV harness can recover them via `q.aiAuthored === true`
on the rendered frontmatter.

## Kill-switch if a model regression sneaks in

AI authoring is always-on, but the design still leaves an easy escape
hatch. Pick the level of disablement you need:

1. **Per-tutorial:** remove the `[AUTOAUTHOR_*]` directive in the
   tutorial's `*-Contribution` repo's `rules.vr`. Next rebuild stops
   generating for that tutorial.
2. **Whole catalog (no code change):** set the `AI_AUTHOR_AICORE_SERVICE_KEY`
   repo secret to empty. The orchestration SDK fails fast on the first
   LLM call. Catalog rebuild still completes — AI expansion is a
   no-op, hand-authored content unaffected.
3. **Whole catalog (revert):** revert the #312 PR to bring the
   `ai-author-enabled` workflow input back as a per-run kill-switch.

## Common failure modes

| Symptom | Likely cause |
|---|---|
| `::error::AI_AUTHOR_AICORE_SERVICE_KEY secret is unset or empty` | Step 3 wasn't done — or the secret was emptied as a deliberate kill-switch (see "Kill-switch" section above). |
| `::error::AI_AUTHOR_AICORE_SERVICE_KEY is not valid JSON` | Secret was set with the outer `{ "credentials": ... }` wrapper instead of just the inner block. Re-run step 2 with the `jq '.credentials'` extraction. |
| Workflow runs but no AI questions appear in tutorials | (a) The pilot tutorial's `*-Contribution` repo doesn't have `[AUTOAUTHOR_*]` directive yet. (b) `[VALIDATE_*]` blocks already cover every step (precedence rule). |
| `[ai-quiz-generator] - generateQuiz upstream error: Request failed with status code 401` | Service key rotated but secret wasn't updated. |
| `[ai-quiz-generator] - generateQuiz upstream error: Request failed with status code 400` | Either deployment ID mismatched the model in `tutorials-aicore`, or `ChatSettings.MODELNAME` was set to something the deployment doesn't serve. |
| `[ai-author] expanded directives ... 0 cache miss, 0 cache hit, 0 errors` | Either no tutorials have AUTOAUTHOR directives yet, or the cache hit before the LLM was needed (re-run with cache wiped: `--regenerate` flag). |

## Refs

- #208 — original spike issue
- #260 — implementation
- #261 — bug fixes + first pilot run
- #275 — graduation-gate evaluation
- #276 — eval CSV parser hardening
- #277 — parser precedence fix (case-sensitive `[X]` regex + regex-substring `handAuthoredSteps`)
- #278 — pre-go-live smoke check (10% sample invariant verification)
- #312 — soak-window close-out + flag removal (always-on)
- #320 — flag default flip-on (started the 2-week soak)
- [docs/developers/architecture/ai-authored-quizzes.md](../architecture/ai-authored-quizzes.md) — design + author flow
