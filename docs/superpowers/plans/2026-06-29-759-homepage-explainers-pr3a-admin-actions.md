# Issue #759 — Homepage Explainers PR 3a: Admin Actions + AI Orchestrator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the backend half of PR 3: three new `AdminService` actions (`generateVerbExplainers`, `generateShelfExplainers`, `generateShelfEntryExplainers`), the AI Core orchestrator that powers them, three system prompts, a kill-switch env var, and hybrid AI test gated by `HYBRID_AI_TESTS=true`. **No visitor-observable change** — and no admin UI change either; the Fiori apps that surface these actions ship in PR 3b. After PR 3a, admins can call the actions via OData (e.g., curl, Insomnia) and watch rows transition `BLANK → AI_SEEDED`.

**Architecture:** New module `srv/lib/explainer-generator.js` wraps the existing `OrchestrationClient` AI Core SDK (already used by `srv/lib/category-classifier-llm.js` for #208 quizzes). One generator per kind (verb / shelf / shelf-entry) — different system prompts, different context shapes, same JSON-schema-constrained tool-call output. Three action handlers in `srv/admin-service.js` follow the established `classifyCategories` pattern: job-lock, Promise.allSettled batching with concurrency cap, structured return shape. Kill-switch env var `AICORE_EXPLAINER_GENERATOR_DISABLED=true` makes all three actions return HTTP 503 — matches the documented kill-switch pattern from #208.

**Tech Stack:** CAP 9 (Node.js), CDS, `@sap-ai-sdk/orchestration` (already in `package.json`), SAP Generative AI Hub (orchestrated mode), Vitest (unit + hybrid workspaces), HANA Cloud via `cds bind`. No frontend.

**Spec:** [`docs/superpowers/specs/2026-06-29-759-homepage-explainers-design.md`](../specs/2026-06-29-759-homepage-explainers-design.md) §3.3, §3.4, §8 (failure modes for the AI generation path).

**Predecessor PRs:** PR 1 (#776, merged) — schema + build feeds. PR 2 (#780, merged) — Vue islands + Hugo wiring.

**Related plans (companion + future PRs):**

- PR 3b: Admin Fiori apps + Homepage facet update — TBW (after PR 3a lands)
- PR 4: Content seed (run bulk-fill-blanks against DEV via PR 3b's admin button) — operational
- PR 5: PROD cutover — operational

---

## File Structure

### New files

- `srv/lib/explainer-generator.js` — AI Core orchestrator; one exported function `generateExplainer({ kind, row, context })` returning `{ tagline, whyItMatters, costCents }` or null on failure. Matches the shape of `srv/lib/category-classifier-llm.js`.
- `srv/lib/prompts/explainer-verb.md` — system prompt for verb explainers (audience: newcomer to SAP).
- `srv/lib/prompts/explainer-shelf.md` — system prompt for shelf-category explainers (shared across all 6 verbs).
- `srv/lib/prompts/explainer-shelf-entry.md` — system prompt for individual link entries (takes verb context).
- `test/unit/srv/lib/explainer-generator.test.js` — unit tests for the orchestrator: prompt assembly, schema validation, cost calculation, kill-switch behavior (mocks AI Core SDK).
- `test/unit/srv/admin-service-explainer-actions.test.js` — unit tests for the three action handlers: auth check, cost-cap enforcement, status transitions, REVIEWED-row protection. Mocks `explainer-generator.js`.
- `test/hybrid/explainer-generation.test.js` — hybrid AI test gated by `HYBRID_AI_TESTS=true`. One real AI Core call per kind (verb / shelf / shelf-entry); asserts JSON shape and status transition. ~$0.05 per run.

### Modified files

- `srv/admin-service.cds` — adds three new actions inside the existing `service AdminService { ... }` block. Defines the return type once as a reusable struct.
- `srv/admin-service.js` — adds three new `this.on(...)` handlers. Reuses the job-lock + Promise.allSettled batching pattern from `classifyCategories` (current handler at lines 1563-1592).
- `.deploy/mta.yaml` — adds `srv/lib/explainer-generator.js` and the three `srv/lib/prompts/explainer-*.md` files to the `tutorials-srv-qa` module's cp-list (per memory [srv-qa cp-list Transitive Deps]).
- `CLAUDE.md` — appends `AICORE_EXPLAINER_GENERATOR_DISABLED` to the env-vars Gotchas list (single-line addition matching the existing entries for `CONTENT_API_KEY`, etc.).

### Deleted files

None — pure additive PR.

---

## Decisions made during plan-writing

| # | Question raised by spec | Decision | Rationale |
|---|---|---|---|
| 1 | Spec §3.3 says actions return `{ processed, skipped, cost }` (cost as USD-cent string). Project has no precedent for cost reporting in action returns — `classifyCategories` returns `{ processed, succeeded, failed, skipped }`. | Match the spec exactly: return `{ processed, skipped, cost }` where `cost` is a string like `"$0.62"`. Add `succeeded` and `failed` counters internally for logging but don't expose them in the OData return type. | Spec was explicit. The user-facing "cost: \$X.XX" string in the success toast (PR 3b) is the load-bearing UX promise. |
| 2 | Spec §3.4 says `generateExplainer` returns `{ tagline, whyItMatters, costCents }` from the AI Core SDK. Token-to-USD conversion has no precedent in runtime code. | Add a small `srv/lib/_token-cost.js` helper. Constants for per-1k-token prices (input + output) per model. Default model: `anthropic--claude-4.6-sonnet` (the project's current chat model). Rates as of 2026-06: \$3/1M input, \$15/1M output (round up to next cent). | The numbers live in code with a clear "edit me when rates change" comment. PR 3b's confirm dialog uses a hard-coded `1.5 cents/call` estimate per the spec; this lib gives actual post-call cost. |
| 3 | Spec §3.3 says hard cap: 100 entries per call. Plan needs to enforce this server-side. | Validate at handler entry: if `ids.length > 100`, return HTTP 400 `{ error: 'CAP_EXCEEDED', limit: 100 }`. CAP's `req.reject(400, message)` is the idiomatic way. | Spec was explicit. Test pin in the action-handler unit test. |
| 4 | Three system prompts as `.md` files vs. JS string constants. | `.md` files in `srv/lib/prompts/`. Imported at runtime via `readFileSync` (synchronous, once per process — these are <1KB each). Allows non-developer editing if needed; cleaner diffs. | Trivial to switch later if it causes deploy-time issues. The srv-qa cp-list audit needs these manually added (they're data files, not JS imports — the transitive-import walker won't find them). |
| 5 | Should the kill-switch env var be `AICORE_EXPLAINER_GENERATOR_DISABLED` (spec) or follow the project's existing `AI_AUTHOR_AICORE_SERVICE_KEY=empty` pattern? | Use a NEW dedicated env var `AICORE_EXPLAINER_GENERATOR_DISABLED=true` (spec). Don't reuse the AI_AUTHOR key because that controls #208 quizzes and we don't want one switch to affect both subsystems. | Spec was explicit. Tested in the orchestrator unit test (returns 503). |
| 6 | Mode `fill-blanks` skips `AI_SEEDED` and `REVIEWED`; mode `regenerate-selected` operates on supplied ids regardless of status. The status transition table has subtleties. | Implement per the spec §3.3 status transition table. The "skipped" counter in the return value distinguishes "AI returned malformed output" (logged + skipped) from "status disqualified the row" (silent skip — not counted). Per-row outcome is logged at debug level for forensics. | The spec's `skipped` definition (AI failure) is the more useful one for the admin UI; the status-disqualified count is implicit (`ids.length` vs `processed` rows). |
| 7 | The `regenerate-selected` mode operating on a `REVIEWED` row sets `authoringStatus = 'AI_SEEDED'` (overwriting the human-reviewed flag). | Match spec §3.3 transition table. The admin UI (PR 3b) shows a confirm dialog before invoking `regenerate-selected` on any REVIEWED row. Server-side, no extra guard — explicit caller intent overrides protection. | Per Decision 3 of the PR 1 plan + spec §3.3. Hybrid test pins this behavior. |
| 8 | Concurrency cap inside the orchestrator (parallel AI Core calls within one batch). | Match `classifyCategories`: `CONCURRENCY = 4`. Per-batch `Promise.allSettled`. Cap is per-action-invocation, not global — multiple admins running in parallel each get their own 4. | Established pattern. AI Core orchestration tier handles its own rate limiting. |
| 9 | Hybrid AI test costs real money. Default `npm run test:hybrid` must stay free. | Gate via `HYBRID_AI_TESTS === 'true'` env var (matches the existing `test/hybrid/categories-classifier.test.js` precedent). Default: skipped. CI never sets the var unless a dedicated AI-test job is added (out of scope for PR 3a). | Established precedent. Cost per run: ~\$0.05 (3 LLM calls, ~500 tokens each). |
| 10 | Where to land the per-action observability — token counts, costs, timing. | `cds.log('explainer-generator').info(...)` for per-call traces; a single info line per batch with totals. No new metrics endpoint, no Splunk integration — the project's existing log scraping picks these up. | YAGNI. Add a dashboard later if it matters. |

---

## Task 1: Add reusable return type + three action signatures to AdminService

**Files:**

- Modify: `srv/admin-service.cds` (insert near the existing `classifyCategories` action — around line 546, inside the same service block)
- Create: `test/unit/srv/admin-service-explainer-actions.test.js` (initial structure with pinning tests for the projection shape)

### Step 1: Read the existing `classifyCategories` action as the structural template

```bash
sed -n '540,560p' srv/admin-service.cds
```

Expected: see the action with `kind`, `ids`, `force` params returning `{ processed, succeeded, failed, skipped }`. Match its shape style.

### Step 2: Write the failing test that pins the three action signatures

Create `test/unit/srv/admin-service-explainer-actions.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CDS = readFileSync(join(import.meta.dirname, '../../../srv/admin-service.cds'), 'utf8');

describe('srv/admin-service.cds — explainer-generation actions (issue #759 PR 3a)', () => {
  it('declares generateVerbExplainers with ids array + mode string', () => {
    expect(CDS).toMatch(/action\s+generateVerbExplainers\s*\(\s*ids\s*:\s*array\s+of\s+String,\s*mode\s*:\s*String\s*\)/);
  });
  it('declares generateShelfExplainers with the same signature', () => {
    expect(CDS).toMatch(/action\s+generateShelfExplainers\s*\(\s*ids\s*:\s*array\s+of\s+String,\s*mode\s*:\s*String\s*\)/);
  });
  it('declares generateShelfEntryExplainers with the same signature', () => {
    expect(CDS).toMatch(/action\s+generateShelfEntryExplainers\s*\(\s*ids\s*:\s*array\s+of\s+String,\s*mode\s*:\s*String\s*\)/);
  });
  it('all three return { processed: Integer; skipped: Integer; cost: String }', () => {
    // Each action's return clause should mention the three fields.
    for (const action of ['generateVerbExplainers', 'generateShelfExplainers', 'generateShelfEntryExplainers']) {
      const re = new RegExp(`${action}[\\s\\S]{0,500}returns\\s+ExplainerActionResult`);
      expect(CDS, action).toMatch(re);
    }
    expect(CDS).toMatch(/type\s+ExplainerActionResult\s*:\s*\{[\s\S]{0,200}processed\s*:\s*Integer;[\s\S]{0,200}skipped\s*:\s*Integer;[\s\S]{0,200}cost\s*:\s*String;[\s\S]{0,50}\}/);
  });
});
```

### Step 3: Run the test to verify it fails

```bash
npx vitest run test/unit/srv/admin-service-explainer-actions.test.js
```

Expected: FAIL — all four assertions miss because the actions don't exist yet.

### Step 4: Add the type + three actions to `srv/admin-service.cds`

Find the existing `classifyCategories` action (around line 546). Immediately **after** the existing `embedAllSeeds` action (the closing `};` of its return shape), insert:

```cds

  // (#759 PR 3a) Homepage explainer AI generation actions.
  // One action per kind (verb / shelf / shelf-entry) so Fiori list-report
  // actions stay scoped to the entity their list displays (FE V4 doesn't
  // handle polymorphic actions cleanly). Shared return shape; shared
  // orchestrator in srv/lib/explainer-generator.js.
  //
  // mode 'fill-blanks'         → process only rows where authoringStatus='BLANK'; ids ignored
  // mode 'regenerate-selected' → process exactly the ids supplied, regardless of status
  //
  // Hard cap: ids.length > 100 returns HTTP 400 (CAP_EXCEEDED).
  // Kill-switch: env AICORE_EXPLAINER_GENERATOR_DISABLED=true → HTTP 503.
  //
  // cost is a USD string like '$0.62' for surfacing in the admin success toast.
  type ExplainerActionResult : {
    processed : Integer;
    skipped   : Integer;
    cost      : String;
  };

  action generateVerbExplainers       (ids : array of String, mode : String) returns ExplainerActionResult;
  action generateShelfExplainers      (ids : array of String, mode : String) returns ExplainerActionResult;
  action generateShelfEntryExplainers (ids : array of String, mode : String) returns ExplainerActionResult;
```

### Step 5: Run the test to verify it passes

```bash
npx vitest run test/unit/srv/admin-service-explainer-actions.test.js
```

Expected: PASS — 4 tests.

### Step 6: Verify CDS still compiles

```bash
npx cds compile srv/admin-service.cds --to json 2>&1 | tail -5
```

Expected: clean output. If you see syntax errors, check that the `ExplainerActionResult` type is declared before the actions that reference it.

### Step 7: Commit

```bash
git add srv/admin-service.cds test/unit/srv/admin-service-explainer-actions.test.js
git -c core.autocrlf=false commit -m "feat(#759): add three explainer-generation actions to AdminService

Per spec §3.3, three new actions for AI explainer generation:
- generateVerbExplainers (operates on VerbDefinitions rows)
- generateShelfExplainers (operates on ShelfDefinitions rows)
- generateShelfEntryExplainers (operates on HomepageShelves rows)

Each accepts (ids: [String], mode: 'fill-blanks' | 'regenerate-selected')
and returns { processed, skipped, cost }. Shared return type
ExplainerActionResult declared once. Handlers in srv/admin-service.js
ship in next task.

Three actions instead of one polymorphic generateExplainers because
Fiori list-report actions are scoped to the entity displayed in the
list — a single action bound to three different lists creates UX
ambiguity FE V4 doesn't handle. Three thin action layers calling one
shared orchestrator (next task) is the cleanest split."
```

---

## Task 2: Create the system prompts

**Files:**

- Create: `srv/lib/prompts/explainer-verb.md`
- Create: `srv/lib/prompts/explainer-shelf.md`
- Create: `srv/lib/prompts/explainer-shelf-entry.md`

### Step 1: Read the existing category-classifier prompt for tone/structure reference

```bash
fd 'prompts' srv/ 2>&1 | head
grep -B2 -A20 'You are' srv/lib/category-classifier-llm.js | head -40
```

Note: category-classifier embeds the prompt as a JS string. PR 3a uses external `.md` files to allow non-developer editing later.

### Step 2: Create `srv/lib/prompts/explainer-verb.md`

```markdown
# Verb explainer

You are writing concise, helpful guidance for the SAP developer portal homepage.
Each of the six "verb" lanes (Learn / Build / Integrate / Operate / Extend with AI / Connect)
needs a short explainer that answers two questions for a newcomer:

1. **Who is this lane for?** (the tagline — one sentence, ≤140 chars)
2. **Why does this lane matter?** (whyItMatters — 1-3 short paragraphs, ≤800 chars)

## Audience

A developer who is new to SAP or new to cloud development on SAP. Assume technical literacy
but no insider vocabulary. Avoid SAP marketing-speak ("the world's leading", "intelligent enterprise", etc.).

## Tone

- Concrete, plain English. Active voice.
- Mention specific technologies where natural (CAP, BTP, HANA, ABAP RAP, Fiori) but don't gate-keep.
- Acknowledge the lane's primary use cases. Be honest about when it's NOT the right starting point.

## Output

You will be asked via a forced tool-call to return EXACTLY:
- `tagline`: string, max 140 chars
- `whyItMatters`: string, max 800 chars

## Input variables

You will be told:
- `verbKey` (LEARN / BUILD / INTEGRATE / OPERATE / AI / CONNECT)
- `label` (e.g., "Learn", "Extend with AI")

## Examples (for shape reference; do NOT copy verbatim)

**LEARN tagline:** "For developers new to SAP or catching up on cloud + AI after years on-prem."

**LEARN whyItMatters:** "Tutorials, learning journeys, and missions get you to first running code fast. Start here if you've never touched SAP CAP or BTP. If you already know SAP and want to skip foundations, go to Build instead."
```

### Step 3: Create `srv/lib/prompts/explainer-shelf.md`

```markdown
# Shelf-category explainer

You are writing concise guidance for one of four shelf categories used on every
verb sub-page of the SAP developer portal (`/learn/`, `/build/`, etc.). The four
shelves are: START_HERE, REFERENCE, TOOLS, KEEP_CURRENT. The same explainer
shows up on all six verb sub-pages — the shelf concept is verb-independent.

## Audience

A developer scanning the verb sub-page and wondering "what kind of thing is on this shelf?"

## Tone

- Plain English. One concept per sentence.
- No reference to specific technologies — shelves are taxonomy, not topics.
- The explainer should answer "what's on this shelf" and "when would I look here."

## Output

Via forced tool-call, return EXACTLY:
- `tagline`: string, max 140 chars
- `whyItMatters`: string, max 800 chars

## Input variables

- `shelfKey` (START_HERE / REFERENCE / TOOLS / KEEP_CURRENT)
- `label` (e.g., "Start here", "Reference", "Tools & samples", "Keep current")

## Shelf-concept shorthand

- **START_HERE**: 1-3 marquee entry points; admin-picked highlights for newcomers.
- **REFERENCE**: Canonical docs, API references, official guides. The "definitive source" shelf.
- **TOOLS**: IDEs, SDKs, GitHub repos, build tooling. The "things you install" shelf.
- **KEEP_CURRENT**: Videos, community blogs, news, release notes. The "what changed recently" shelf.

## Example

**START_HERE tagline:** "A few hand-picked starting points for this lane."

**START_HERE whyItMatters:** "Curated entry points — not exhaustive, just the ones the SAP team recommends if you're new to this lane. If you've done these and want more, go to REFERENCE for docs or TOOLS for the codebases."
```

### Step 4: Create `srv/lib/prompts/explainer-shelf-entry.md`

```markdown
# Shelf-entry (per-link) explainer

You are writing a short popover explainer for an individual link on the SAP developer
portal homepage or a verb sub-page. The link is one of ~60 destinations across six
verb lanes — could be an SAP product (SAP Joule), a tool (BTP cockpit), a learning
resource, a community channel, anything in the developer destination catalog.

## Audience

A developer who's hovering over the link wondering "what is this and why should I care?"

## Tone

- Plain English. Concrete. No marketing fluff.
- Mention what category of thing this is (product, tool, doc, community) in the first sentence.
- If the entry has known limitations or is the wrong fit for certain audiences, say so honestly.

## Output

Via forced tool-call, return EXACTLY:
- `tagline`: string, max 140 chars
- `whyItMatters`: string, max 800 chars

## Input variables

- `title` (the link's display title, e.g., "SAP Joule")
- `url` (the destination, useful for context — domain hints at product category)
- `description` (existing 280-char description, may be empty)
- `verbLabel` (the lane this entry lives in, e.g., "Extend with AI")
- `verbTagline` (the lane's tagline, for situational awareness — your output should NOT repeat it)

## Example

**SAP Joule tagline:** "SAP's generative-AI copilot embedded across SAP applications."

**SAP Joule whyItMatters:** "Joule is the user-facing AI surface in SAP products — think of it as the chat panel in S/4HANA, SuccessFactors, etc. If you're integrating AI into an SAP-hosted app, Joule is the consumption surface. For building NEW AI features from scratch, use AI Core via the BTP AI Foundation lane instead."
```

### Step 5: Commit

```bash
git add srv/lib/prompts/
git -c core.autocrlf=false commit -m "feat(#759): system prompts for the three explainer-generation kinds

Three short Markdown prompts in srv/lib/prompts/:
- explainer-verb.md (audience: newcomer; output: tagline + whyItMatters per verb)
- explainer-shelf.md (audience: scanning user; output: per-shelf-category explainer)
- explainer-shelf-entry.md (audience: hovering user; output: per-link explainer with verb context)

Each is < 1KB. Loaded synchronously once per process by the orchestrator
(next task). External .md files (not JS string constants) so editors
can rev tone without touching code; cleaner diffs."
```

---

## Task 3: Build the AI Core orchestrator

**Files:**

- Create: `srv/lib/explainer-generator.js`
- Create: `srv/lib/_token-cost.js` (small helper)
- Create: `test/unit/srv/lib/explainer-generator.test.js`

### Step 1: Read the existing AI Core wrapper for pattern reference

```bash
sed -n '1,100p' srv/lib/category-classifier-llm.js
```

Note the construction of `OrchestrationClient`, the forced `tool_choice`, and the response-handling block.

### Step 2: Write the failing orchestrator test

Create `test/unit/srv/lib/explainer-generator.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// We mock the AI Core SDK at the module level so the unit test never
// hits real AI Core. The hybrid test exercises the real path.
vi.mock('@sap-ai-sdk/orchestration', () => ({
  OrchestrationClient: vi.fn().mockImplementation(() => ({
    chatCompletion: vi.fn().mockResolvedValue({
      getContent: () => null,
      getToolCalls: () => [{
        function: {
          name: 'submit_explainer',
          arguments: JSON.stringify({
            tagline: 'Test tagline',
            whyItMatters: 'Test whyItMatters paragraph.',
          }),
        },
      }],
      getTokenUsage: () => ({ prompt_tokens: 200, completion_tokens: 100 }),
    }),
  })),
}));

import { generateExplainer } from '../../../../srv/lib/explainer-generator.js';

describe('srv/lib/explainer-generator.js', () => {
  beforeEach(() => { vi.clearAllMocks(); delete process.env.AICORE_EXPLAINER_GENERATOR_DISABLED; });
  afterEach(() => { delete process.env.AICORE_EXPLAINER_GENERATOR_DISABLED; });

  it('generates a verb explainer and returns { tagline, whyItMatters, costCents }', async () => {
    const result = await generateExplainer({
      kind: 'verb',
      row: { verbKey: 'LEARN', label: 'Learn' },
    });
    expect(result).toMatchObject({
      tagline: 'Test tagline',
      whyItMatters: 'Test whyItMatters paragraph.',
    });
    expect(typeof result.costCents).toBe('number');
    expect(result.costCents).toBeGreaterThan(0);
  });

  it('generates a shelf explainer', async () => {
    const result = await generateExplainer({
      kind: 'shelf',
      row: { shelfKey: 'REFERENCE', label: 'Reference' },
    });
    expect(result.tagline).toBe('Test tagline');
  });

  it('generates a shelf-entry explainer with verb context', async () => {
    const result = await generateExplainer({
      kind: 'shelf-entry',
      row: { title: 'SAP Joule', url: 'https://help.sap.com/docs/joule', description: '' },
      context: { verbDefinition: { label: 'Extend with AI', tagline: 'Build AI into SAP apps' } },
    });
    expect(result.whyItMatters).toBe('Test whyItMatters paragraph.');
  });

  it('returns null when AICORE_EXPLAINER_GENERATOR_DISABLED=true', async () => {
    process.env.AICORE_EXPLAINER_GENERATOR_DISABLED = 'true';
    const result = await generateExplainer({
      kind: 'verb',
      row: { verbKey: 'LEARN', label: 'Learn' },
    });
    expect(result).toBeNull();
  });

  it('throws on unknown kind', async () => {
    await expect(
      generateExplainer({ kind: 'bogus', row: {} })
    ).rejects.toThrow(/unknown kind/i);
  });
});
```

### Step 3: Run the test to verify it fails

```bash
npx vitest run test/unit/srv/lib/explainer-generator.test.js
```

Expected: FAIL — module doesn't exist.

### Step 4: Create the token-cost helper

Create `srv/lib/_token-cost.js`:

```js
// srv/lib/_token-cost.js
//
// Token-count → USD-cent conversion for AI Core orchestration costs.
//
// Rates as of 2026-06 for the project's default chat model
// (anthropic--claude-4.6-sonnet via SAP Generative AI Hub):
//   input:  $3 per 1M tokens
//   output: $15 per 1M tokens
// Rates ARE different per model; if ChatSettings.modelName changes, update
// the RATES map below. This is intentionally simple — a few-line update
// when SAP changes pricing is preferable to a config-table indirection.

const RATES = {
  'anthropic--claude-4.6-sonnet': { inputPerMillion: 3.00, outputPerMillion: 15.00 },
  // Fallback when modelName is unknown — use the conservative (highest)
  // rate so we never under-report cost.
  '__default__':                   { inputPerMillion: 3.00, outputPerMillion: 15.00 },
};

/**
 * @param {object} usage
 * @param {number} usage.promptTokens
 * @param {number} usage.completionTokens
 * @param {string} [usage.modelName] - falls back to '__default__' rates
 * @returns {number} cost in cents, rounded UP to next integer cent
 */
export function tokensToCents(usage) {
  const rates = RATES[usage.modelName] ?? RATES.__default__;
  const inputCost  = (usage.promptTokens     / 1_000_000) * rates.inputPerMillion;
  const outputCost = (usage.completionTokens / 1_000_000) * rates.outputPerMillion;
  return Math.ceil((inputCost + outputCost) * 100);
}

/**
 * Format a cent count as a USD string for display, e.g., 62 → '$0.62'.
 * Used by action handlers to fill the `cost` field of the return shape.
 */
export function centsToUsdString(cents) {
  const dollars = Math.floor(cents / 100);
  const remainder = cents % 100;
  return `$${dollars}.${remainder.toString().padStart(2, '0')}`;
}
```

### Step 5: Create the orchestrator

Create `srv/lib/explainer-generator.js`:

```js
// srv/lib/explainer-generator.js
//
// AI Core orchestrator for homepage explainer generation (issue #759).
//
// One public function `generateExplainer({ kind, row, context })` →
// { tagline, whyItMatters, costCents } | null.
//
// kind: 'verb' | 'shelf' | 'shelf-entry'
// row:  the entity row (VerbDefinitions / ShelfDefinitions / HomepageShelves)
// context: { verbDefinition?: { label, tagline } } — required for shelf-entry kind
//
// Returns null when AICORE_EXPLAINER_GENERATOR_DISABLED=true is set on
// the srv app's env. Throws on unknown kind. Logs to cds.log('explainer-generator').
//
// Uses a forced tool-call (tool_choice='submit_explainer') so the model
// MUST return JSON with `tagline` and `whyItMatters` fields. Mirrors the
// pattern from srv/lib/category-classifier-llm.js (#208 / #201).

import cds from '@sap/cds';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OrchestrationClient } from '@sap-ai-sdk/orchestration';
import { tokensToCents } from './_token-cost.js';

const LOG = cds.log('explainer-generator');

const TOOL_NAME = 'submit_explainer';
const TEMPERATURE = 0.4;   // some creativity for variety, but bounded
const MAX_TOKENS = 600;

// Default model — overridable via ChatSettings.modelName (looked up per call).
const DEFAULT_MODEL = 'anthropic--claude-4.6-sonnet';

// Load all three prompt files once at module-init time. They're small
// (<1KB each) and never change at runtime.
const PROMPTS = {
  'verb':         readFileSync(join(import.meta.dirname, 'prompts', 'explainer-verb.md'), 'utf8'),
  'shelf':        readFileSync(join(import.meta.dirname, 'prompts', 'explainer-shelf.md'), 'utf8'),
  'shelf-entry':  readFileSync(join(import.meta.dirname, 'prompts', 'explainer-shelf-entry.md'), 'utf8'),
};

const TOOL_SPEC = {
  type: 'function',
  function: {
    name: TOOL_NAME,
    description: 'Submit the generated explainer for a homepage destination',
    parameters: {
      type: 'object',
      properties: {
        tagline: {
          type: 'string',
          description: 'One-sentence "who is this for" hook, max 140 chars',
          maxLength: 140,
        },
        whyItMatters: {
          type: 'string',
          description: '1-3 short paragraphs explaining the destination, max 800 chars',
          maxLength: 800,
        },
      },
      required: ['tagline', 'whyItMatters'],
      additionalProperties: false,
    },
  },
};

function buildUserMessage(kind, row, context) {
  if (kind === 'verb') {
    return `Generate a tagline + whyItMatters for the **${row.label}** lane (verbKey: ${row.verbKey}).`;
  }
  if (kind === 'shelf') {
    return `Generate a tagline + whyItMatters for the **${row.label}** shelf category (shelfKey: ${row.shelfKey}). Remember: same explainer shows on all six verb sub-pages.`;
  }
  if (kind === 'shelf-entry') {
    const verbContext = context?.verbDefinition
      ? `\n\nThis link lives in the **${context.verbDefinition.label}** lane (${context.verbDefinition.tagline || 'no tagline'}).`
      : '';
    const desc = row.description ? `\n\nExisting one-line description (use as background, don't repeat verbatim): ${row.description}` : '';
    return `Generate a tagline + whyItMatters for **${row.title}** (URL: ${row.url}).${verbContext}${desc}`;
  }
  throw new Error(`unknown kind: ${kind}`);
}

export async function generateExplainer({ kind, row, context }) {
  if (process.env.AICORE_EXPLAINER_GENERATOR_DISABLED === 'true') {
    LOG.info(`[${kind}] generator disabled via env; returning null`);
    return null;
  }

  if (!PROMPTS[kind]) {
    throw new Error(`unknown kind: ${kind}`);
  }

  const systemPrompt = PROMPTS[kind];
  const userMessage = buildUserMessage(kind, row, context);

  const modelName = DEFAULT_MODEL;

  const client = new OrchestrationClient(
    {
      promptTemplating: {
        model: {
          name: modelName,
          params: {
            max_tokens: MAX_TOKENS,
            temperature: TEMPERATURE,
            tool_choice: { type: 'function', function: { name: TOOL_NAME } },
            tools: [TOOL_SPEC],
          },
        },
      },
    },
    {} // deploymentId / resourceGroup picked up from cds.requires/env
  );

  let response;
  try {
    response = await client.chatCompletion({
      messagesHistory: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userMessage },
      ],
    });
  } catch (err) {
    LOG.warn(`[${kind}] AI Core call failed: ${err.message}`);
    return null;
  }

  // Extract structured output from the forced tool-call.
  const toolCalls = response.getToolCalls?.() ?? [];
  const submitCall = toolCalls.find(tc => tc.function?.name === TOOL_NAME);
  if (!submitCall) {
    LOG.warn(`[${kind}] AI response missing ${TOOL_NAME} tool-call; row skipped`);
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(submitCall.function.arguments);
  } catch (err) {
    LOG.warn(`[${kind}] tool-call arguments not valid JSON: ${err.message}`);
    return null;
  }

  if (typeof parsed.tagline !== 'string' || typeof parsed.whyItMatters !== 'string') {
    LOG.warn(`[${kind}] tool-call missing required fields`);
    return null;
  }

  // Enforce length caps server-side as a backstop (the schema already
  // declares them, but trust-but-verify).
  parsed.tagline      = parsed.tagline.slice(0, 140);
  parsed.whyItMatters = parsed.whyItMatters.slice(0, 800);

  const usage = response.getTokenUsage?.() ?? {};
  const costCents = tokensToCents({
    promptTokens:     usage.prompt_tokens     ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    modelName,
  });

  LOG.info(`[${kind}] generated explainer for ${row.label ?? row.title ?? '?'} — ${costCents}¢ (${usage.prompt_tokens ?? '?'} prompt + ${usage.completion_tokens ?? '?'} completion tokens)`);

  return {
    tagline: parsed.tagline,
    whyItMatters: parsed.whyItMatters,
    costCents,
  };
}
```

### Step 6: Run the orchestrator test

```bash
npx vitest run test/unit/srv/lib/explainer-generator.test.js
```

Expected: PASS — 5 tests.

### Step 7: Commit

```bash
git add srv/lib/explainer-generator.js srv/lib/_token-cost.js test/unit/srv/lib/explainer-generator.test.js
git -c core.autocrlf=false commit -m "feat(#759): AI Core orchestrator for homepage explainer generation

New srv/lib/explainer-generator.js wraps the existing
@sap-ai-sdk/orchestration OrchestrationClient — same pattern as
srv/lib/category-classifier-llm.js (#201 / #208). One public function
generateExplainer({ kind, row, context }) returning
{ tagline, whyItMatters, costCents } or null on failure / disabled.

Three kinds:
- 'verb' (audience: newcomer to SAP)
- 'shelf' (audience: scanning user; explains shelf categories)
- 'shelf-entry' (audience: hovering user; needs verb context)

Each forced tool-call schema constrains output to { tagline: ≤140 chars,
whyItMatters: ≤800 chars }. Server-side slice() as a length backstop.

Companion srv/lib/_token-cost.js converts token usage to USD cents
using per-1M-token rates (input \$3, output \$15 for the default
claude-4.6-sonnet model). Update the RATES map when SAP pricing
changes.

Kill-switch: env AICORE_EXPLAINER_GENERATOR_DISABLED=true returns null
silently. Action handlers (next task) surface this as HTTP 503.

5 unit tests with the AI Core SDK mocked at the module level — never
hits real AI Core. The hybrid test (Task 7) exercises the real path
gated by HYBRID_AI_TESTS=true."
```

---

## Task 4: Implement the three action handlers in `srv/admin-service.js`

**Files:**

- Modify: `srv/admin-service.js` (add three new `this.on(...)` handlers, ideally near `classifyCategories`)
- Modify: `test/unit/srv/admin-service-explainer-actions.test.js` (extend with handler-behavior tests)

### Step 1: Read the existing `classifyCategories` handler pattern

```bash
sed -n '1560,1600p' srv/admin-service.js
```

Note: job-lock acquisition, `Promise.allSettled` batching with CONCURRENCY = 4, structured return.

### Step 2: Extend the failing test for handler behavior

Append to `test/unit/srv/admin-service-explainer-actions.test.js`:

```js
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import cds from '@sap/cds';

// Mock the generator so action tests never hit real AI Core.
vi.mock('../../../srv/lib/explainer-generator.js', () => ({
  generateExplainer: vi.fn().mockResolvedValue({
    tagline: 'Mocked tagline',
    whyItMatters: 'Mocked whyItMatters.',
    costCents: 15,
  }),
}));

const ADMIN_AUTH = { auth: { username: 'admin', password: 'admin' } };

describe('AdminService.generate*Explainers — action handlers (#759 PR 3a)', () => {
  let project;
  beforeAll(async () => {
    project = cds.test('serve', '--project', '.', '--in-memory');
    await project;
  });

  beforeEach(async () => {
    // Reset Verb / Shelf / Shelf-entry tables to a known state
    const db = await cds.connect.to('db');
    await db.run(DELETE.from('com.sap.developers.ims.VerbDefinitions'));
    await db.run(DELETE.from('com.sap.developers.ims.ShelfDefinitions'));
    await db.run(DELETE.from('com.sap.developers.ims.HomepageShelves'));
    // Trigger auto-init by reading via AdminService projection.
    await project.get('/admin/VerbDefinitions',  ADMIN_AUTH);
    await project.get('/admin/ShelfDefinitions', ADMIN_AUTH);
  });

  describe('fill-blanks mode', () => {
    it('VerbDefinitions: processes all 6 BLANK rows, returns processed=6', async () => {
      const res = await project.post('/admin/generateVerbExplainers',
        { ids: [], mode: 'fill-blanks' }, ADMIN_AUTH);
      expect(res.status).toBe(200);
      expect(res.data.processed).toBe(6);
      expect(res.data.skipped).toBe(0);
      expect(res.data.cost).toMatch(/^\$\d+\.\d{2}$/);
    });

    it('VerbDefinitions: skips AI_SEEDED and REVIEWED rows', async () => {
      const db = await cds.connect.to('db');
      await db.run(UPDATE('com.sap.developers.ims.VerbDefinitions')
        .set({ authoringStatus: 'AI_SEEDED' })
        .where({ verbKey: 'LEARN' }));
      await db.run(UPDATE('com.sap.developers.ims.VerbDefinitions')
        .set({ authoringStatus: 'REVIEWED' })
        .where({ verbKey: 'BUILD' }));
      const res = await project.post('/admin/generateVerbExplainers',
        { ids: [], mode: 'fill-blanks' }, ADMIN_AUTH);
      expect(res.data.processed).toBe(4); // LEARN + BUILD untouched; 4 BLANK rows processed
    });
  });

  describe('regenerate-selected mode', () => {
    it('ShelfDefinitions: processes only the specified ids', async () => {
      const db = await cds.connect.to('db');
      const rows = await db.run(SELECT.from('com.sap.developers.ims.ShelfDefinitions').columns('ID'));
      const twoIds = [rows[0].ID, rows[1].ID];
      const res = await project.post('/admin/generateShelfExplainers',
        { ids: twoIds, mode: 'regenerate-selected' }, ADMIN_AUTH);
      expect(res.data.processed).toBe(2);
    });

    it('ShelfDefinitions: overwrites REVIEWED status (admin explicit-intent)', async () => {
      const db = await cds.connect.to('db');
      const rows = await db.run(SELECT.from('com.sap.developers.ims.ShelfDefinitions').columns('ID', 'shelfKey'));
      const reviewed = rows[0];
      await db.run(UPDATE('com.sap.developers.ims.ShelfDefinitions')
        .set({ authoringStatus: 'REVIEWED' })
        .where({ ID: reviewed.ID }));
      const res = await project.post('/admin/generateShelfExplainers',
        { ids: [reviewed.ID], mode: 'regenerate-selected' }, ADMIN_AUTH);
      expect(res.data.processed).toBe(1);
      const after = await db.run(SELECT.one.from('com.sap.developers.ims.ShelfDefinitions')
        .where({ ID: reviewed.ID }));
      expect(after.authoringStatus).toBe('AI_SEEDED');
    });
  });

  describe('100-row cap', () => {
    it('returns HTTP 400 CAP_EXCEEDED when ids.length > 100', async () => {
      const tooManyIds = Array.from({ length: 101 }, (_, i) => `id-${i}`);
      const res = await project.post('/admin/generateShelfEntryExplainers',
        { ids: tooManyIds, mode: 'regenerate-selected' }, ADMIN_AUTH)
        .catch(err => err.response); // CAP throws on non-2xx; capture response
      expect(res.status).toBe(400);
      expect(res.data.error?.message ?? res.data.message ?? '').toMatch(/CAP_EXCEEDED|exceeded/i);
    });
  });

  describe('kill-switch', () => {
    it('returns HTTP 503 when AICORE_EXPLAINER_GENERATOR_DISABLED=true', async () => {
      process.env.AICORE_EXPLAINER_GENERATOR_DISABLED = 'true';
      try {
        const res = await project.post('/admin/generateVerbExplainers',
          { ids: [], mode: 'fill-blanks' }, ADMIN_AUTH)
          .catch(err => err.response);
        expect(res.status).toBe(503);
      } finally {
        delete process.env.AICORE_EXPLAINER_GENERATOR_DISABLED;
      }
    });
  });
});
```

### Step 3: Run the test to verify it fails

```bash
npx vitest run test/unit/srv/admin-service-explainer-actions.test.js
```

Expected: FAIL — handlers don't exist yet. Existing CDS pinning tests should still pass.

### Step 4: Add the three handlers to `srv/admin-service.js`

Find the existing `classifyCategories` handler (around line 1563). Immediately **after** the existing `embedAllSeeds` handler (the closing `});` of its block), insert:

```js
    // --- (#759 PR 3a) Homepage explainer AI generation actions ---
    //
    // Three near-identical action handlers; the only differences are:
    //   - which entity table (VerbDefinitions / ShelfDefinitions / HomepageShelves)
    //   - which kind passed to generateExplainer ('verb' / 'shelf' / 'shelf-entry')
    //   - which key column ('verbKey' / 'shelfKey' / 'ID')
    //
    // Shared concerns: cap-check, kill-switch, mode dispatch, batch with
    // Promise.allSettled at CONCURRENCY=4, status-transition rules per
    // spec §3.3, structured return shape with USD-cent cost.
    const EXPLAINER_GENERATOR_CONCURRENCY = 4;
    const EXPLAINER_HARD_CAP = 100;

    async function runExplainerAction({ kind, entityName, ids, mode, contextLookup, req }) {
      if (process.env.AICORE_EXPLAINER_GENERATOR_DISABLED === 'true') {
        req.reject(503, 'AI_GENERATION_DISABLED');
        return;
      }
      const idsArr = Array.isArray(ids) ? ids : [];
      if (idsArr.length > EXPLAINER_HARD_CAP) {
        req.reject(400, `CAP_EXCEEDED: limit ${EXPLAINER_HARD_CAP}`);
        return;
      }

      const { generateExplainer } = await import('./lib/explainer-generator.js');
      const { centsToUsdString } = await import('./lib/_token-cost.js');
      const db = await cds.connect.to('db');

      // Select target rows by mode.
      let rows;
      if (mode === 'fill-blanks') {
        rows = await db.run(
          SELECT.from(entityName).where({ authoringStatus: 'BLANK' })
        );
      } else if (mode === 'regenerate-selected') {
        if (idsArr.length === 0) return { processed: 0, skipped: 0, cost: '$0.00' };
        rows = await db.run(
          SELECT.from(entityName).where({ ID: { in: idsArr } })
        );
      } else {
        req.reject(400, `unknown mode: ${mode}`);
        return;
      }

      // Process in batches of CONCURRENCY=4, accumulate.
      let totalCents = 0;
      let processed = 0;
      let skipped = 0;
      for (let i = 0; i < rows.length; i += EXPLAINER_GENERATOR_CONCURRENCY) {
        const batch = rows.slice(i, i + EXPLAINER_GENERATOR_CONCURRENCY);
        const results = await Promise.allSettled(batch.map(async (row) => {
          const context = contextLookup ? await contextLookup(row) : undefined;
          const result = await generateExplainer({ kind, row, context });
          if (!result) return null;
          await db.run(
            UPDATE(entityName)
              .set({
                tagline:         result.tagline,
                whyItMatters:    result.whyItMatters,
                authoringStatus: 'AI_SEEDED',
              })
              .where({ ID: row.ID })
          );
          return result.costCents;
        }));
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value !== null) {
            processed++;
            totalCents += r.value;
          } else {
            skipped++;
          }
        }
      }
      return {
        processed,
        skipped,
        cost: centsToUsdString(totalCents),
      };
    }

    this.on('generateVerbExplainers', async (req) => {
      const { ids, mode } = req.data;
      return runExplainerAction({
        kind: 'verb',
        entityName: 'com.sap.developers.ims.VerbDefinitions',
        ids, mode, req,
      });
    });

    this.on('generateShelfExplainers', async (req) => {
      const { ids, mode } = req.data;
      return runExplainerAction({
        kind: 'shelf',
        entityName: 'com.sap.developers.ims.ShelfDefinitions',
        ids, mode, req,
      });
    });

    this.on('generateShelfEntryExplainers', async (req) => {
      const { ids, mode } = req.data;
      // shelf-entry needs verb context: look up VerbDefinitions[verbKey == row.verb] per row.
      return runExplainerAction({
        kind: 'shelf-entry',
        entityName: 'com.sap.developers.ims.HomepageShelves',
        ids, mode, req,
        contextLookup: async (row) => {
          const db = await cds.connect.to('db');
          const verbDef = await db.run(
            SELECT.one.from('com.sap.developers.ims.VerbDefinitions')
              .where({ verbKey: row.verb })
          );
          return verbDef ? { verbDefinition: { label: verbDef.label, tagline: verbDef.tagline } } : undefined;
        },
      });
    });
```

### Step 5: Run the test to verify it passes

```bash
npx vitest run test/unit/srv/admin-service-explainer-actions.test.js
```

Expected: PASS — all tests (CDS-pinning + handler-behavior).

### Step 6: Commit

```bash
git add srv/admin-service.js test/unit/srv/admin-service-explainer-actions.test.js
git -c core.autocrlf=false commit -m "feat(#759): action handlers for the three explainer-generation actions

Three thin wrappers around a shared runExplainerAction() helper in
srv/admin-service.js. Each handler binds to its entity (VerbDefinitions,
ShelfDefinitions, HomepageShelves) and its kind ('verb' / 'shelf' /
'shelf-entry'), then delegates to the helper.

Shared concerns handled by the helper:
- Kill-switch: AICORE_EXPLAINER_GENERATOR_DISABLED=true → HTTP 503
- Hard cap: ids.length > 100 → HTTP 400 CAP_EXCEEDED
- Mode dispatch: 'fill-blanks' targets authoringStatus='BLANK' only;
  'regenerate-selected' targets supplied ids regardless of status
- Batched execution: CONCURRENCY=4 with Promise.allSettled
- Status transition: any successful generation flips authoringStatus
  to AI_SEEDED (overwrites REVIEWED in regenerate-selected mode per
  spec §3.3 — admin explicit-intent)
- USD-cent cost accumulation: helper returns total as '\$X.XX' string

The shelf-entry handler additionally looks up VerbDefinitions for each
row's verb so the AI prompt has lane context (per spec §3.4).

Existing patterns reused: job-lock not added here (these actions are
short and idempotent — re-running fill-blanks is safe), CONCURRENCY=4
matches classifyCategories (#201)."
```

---

## Task 5: Add the kill-switch env var doc to CLAUDE.md

**Files:**

- Modify: `CLAUDE.md` (append to the existing Gotchas list of env vars)

### Step 1: Find the existing env-vars list

```bash
grep -n 'CONTENT_API_KEY\|GITHUB_DISPATCH_TOKEN\|SUBMISSION_SALT_SECRET\|AICORE_EXPLAINER' CLAUDE.md | head -10
```

Look for the section listing operational env vars (probably under "Gotchas" or "## Constraints").

### Step 2: Add a single-line entry

Find a natural insertion point (alphabetically with the other `AICORE_*` or env-var entries). Insert:

```markdown
- **`AICORE_EXPLAINER_GENERATOR_DISABLED` env var** — Kill-switch for the homepage explainer AI generation (#759). When set to `'true'`, all three `AdminService.generate*Explainers` actions return HTTP 503 immediately. Use for incident response (e.g., AI Core quota burned, prompt regression, cost runaway). Hand-authored content survives — only AI generation is blocked.
```

### Step 3: Commit

```bash
git add CLAUDE.md
git -c core.autocrlf=false commit -m "docs(#759): document AICORE_EXPLAINER_GENERATOR_DISABLED kill-switch env var"
```

---

## Task 6: srv-qa cp-list — add explainer-generator + prompts

**Files:**

- Modify: `.deploy/mta.yaml` (the `tutorials-srv-qa` module's `cp` command)

### Step 1: Find the current srv-qa cp-list

```bash
grep -n 'srv-qa\|cp.*srv/lib' .deploy/mta.yaml | head -20
```

Look for the `tutorials-srv-qa` module block; find the `cp` line that copies `srv/lib/*` files.

### Step 2: Add the new files

Edit `.deploy/mta.yaml`. Find the existing cp command (probably a long bash one-liner copying srv/lib/*.js files). Add:

- `srv/lib/explainer-generator.js`
- `srv/lib/_token-cost.js`
- `srv/lib/prompts/explainer-verb.md`
- `srv/lib/prompts/explainer-shelf.md`
- `srv/lib/prompts/explainer-shelf-entry.md`

**Note**: the prompts are `.md` files (data, not JS). The check-srv-qa-cp-list audit (existing unit test) walks transitive JS imports — it WILL find `srv/lib/_token-cost.js` (imported by `explainer-generator.js`) but it WILL NOT find the `.md` files. The mta.yaml manual addition is the only safety net.

You may need to use `mkdir -p` to create `srv-qa/srv/lib/prompts/` before copying, depending on how the existing cp command is structured. Mirror the surrounding pattern exactly.

### Step 3: Verify the audit test still passes (the JS files are tracked)

```bash
npx vitest run test/unit/check-srv-qa-cp-list.test.js 2>&1 | tail -5
```

Expected: still passes. If it fails listing `explainer-generator.js` or `_token-cost.js` as missing, the mta.yaml addition wasn't picked up — re-check.

### Step 4: Commit

```bash
git add .deploy/mta.yaml
git -c core.autocrlf=false commit -m "build(#759): add explainer-generator + prompts to srv-qa cp-list

Per memory [srv-qa cp-list Transitive Deps], srv/lib/*.js files
imported by content-store.js need explicit cp in .deploy/mta.yaml
for the tutorials-srv-qa module. Adds:

- srv/lib/explainer-generator.js
- srv/lib/_token-cost.js (imported by explainer-generator)
- srv/lib/prompts/explainer-verb.md
- srv/lib/prompts/explainer-shelf.md
- srv/lib/prompts/explainer-shelf-entry.md

The .md prompts are data files, not JS modules — the transitive-import
walker in check-srv-qa-cp-list will not find them. They must stay in
the mta.yaml manual list."
```

---

## Task 7: Hybrid AI test (gated by `HYBRID_AI_TESTS=true`)

**Files:**

- Create: `test/hybrid/explainer-generation.test.js`

### Step 1: Read the existing categories-classifier hybrid test as the gate-pattern reference

```bash
sed -n '1,30p' test/hybrid/categories-classifier.test.js
```

Note the `RUN = process.env.HYBRID_AI_TESTS === 'true' && isSafeForWrites()` pattern, then `(RUN ? describe : describe.skip)(...)`.

### Step 2: Write the hybrid test

Create `test/hybrid/explainer-generation.test.js`:

```js
// Hybrid AI test for the homepage explainer generator (#759 PR 3a).
//
// Gated by HYBRID_AI_TESTS=true so default `npm run test:hybrid` stays
// free. When enabled, makes 3 real AI Core calls (~$0.05 total).
// Asserts the orchestrator returns the expected JSON shape and the
// action handler persists the status transition.

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

const RUN = process.env.HYBRID_AI_TESTS === 'true' && isSafeForWrites();

(RUN ? describe : describe.skip)('hybrid: explainer generation against real HANA + AI Core (#759 PR 3a)', () => {
  let db;
  beforeAll(async () => { db = await cds.connect.to('db'); });

  it('generates a verb explainer end-to-end', async () => {
    const { generateExplainer } = await import('../../srv/lib/explainer-generator.js');
    const result = await generateExplainer({
      kind: 'verb',
      row: { verbKey: 'LEARN', label: 'Learn' },
    });
    expect(result).not.toBeNull();
    expect(typeof result.tagline).toBe('string');
    expect(result.tagline.length).toBeGreaterThan(0);
    expect(result.tagline.length).toBeLessThanOrEqual(140);
    expect(typeof result.whyItMatters).toBe('string');
    expect(result.whyItMatters.length).toBeGreaterThan(0);
    expect(result.whyItMatters.length).toBeLessThanOrEqual(800);
    expect(result.costCents).toBeGreaterThan(0);
  });

  it('generates a shelf explainer', async () => {
    const { generateExplainer } = await import('../../srv/lib/explainer-generator.js');
    const result = await generateExplainer({
      kind: 'shelf',
      row: { shelfKey: 'START_HERE', label: 'Start here' },
    });
    expect(result?.tagline).toBeTruthy();
  });

  it('generates a shelf-entry explainer with verb context', async () => {
    const { generateExplainer } = await import('../../srv/lib/explainer-generator.js');
    const result = await generateExplainer({
      kind: 'shelf-entry',
      row: {
        title: 'SAP Joule',
        url: 'https://help.sap.com/docs/joule',
        description: 'SAP\'s generative AI copilot',
      },
      context: {
        verbDefinition: {
          label: 'Extend with AI',
          tagline: 'Build AI capabilities into SAP apps',
        },
      },
    });
    expect(result?.whyItMatters).toBeTruthy();
  });

  it('action handler persists status transition BLANK → AI_SEEDED', async () => {
    const admin = await cds.connect.to('AdminService');
    // Pick a verb that's currently BLANK; reset if needed.
    await db.run(UPDATE('com.sap.developers.ims.VerbDefinitions')
      .set({ authoringStatus: 'BLANK', tagline: null, whyItMatters: null })
      .where({ verbKey: 'CONNECT' }));
    const result = await admin.send('generateVerbExplainers', {
      ids: [], mode: 'fill-blanks',
    });
    expect(result.processed).toBeGreaterThan(0);
    const after = await db.run(SELECT.one.from('com.sap.developers.ims.VerbDefinitions')
      .where({ verbKey: 'CONNECT' }));
    expect(['AI_SEEDED', 'REVIEWED']).toContain(after.authoringStatus);
    expect(after.tagline?.length).toBeGreaterThan(0);
  });
});
```

### Step 3: Confirm the test skips by default

```bash
npm run test:hybrid -- explainer-generation 2>&1 | tail -10
```

Expected: tests SKIPPED. (`HYBRID_AI_TESTS` not set, so the gate evaluates false.)

### Step 4 (optional, only if you have CF login + want to verify): Run with the gate enabled

```bash
HYBRID_AI_TESTS=true npm run test:hybrid -- explainer-generation 2>&1 | tail -15
```

Expected: 4 tests pass, ~$0.10 in AI Core costs (3 generation calls + 1 action call which itself does N generations for the BLANK rows).

If you're not logged into CF or don't want to spend the AI Core call, skip this step — the test is committed and CI / a future run can exercise it.

### Step 5: Commit

```bash
git add test/hybrid/explainer-generation.test.js
git -c core.autocrlf=false commit -m "test(#759): hybrid AI test for explainer generation (HYBRID_AI_TESTS gate)

Four tests gated by HYBRID_AI_TESTS=true + isSafeForWrites() (matches
the existing categories-classifier hybrid test pattern). Default
npm run test:hybrid skips this file — no cost. Opted-in runs make
three real AI Core calls (~\$0.05) plus one full action invocation.

Asserts:
- generateExplainer for each of the three kinds returns the expected
  { tagline ≤140, whyItMatters ≤800, costCents > 0 } shape
- generateVerbExplainers action persists BLANK → AI_SEEDED transition
  and writes non-empty tagline back to the DB"
```

---

## Task 8: Full local unit-test smoke

**Files:** none (verification only)

### Step 1: Run all the new unit tests

```bash
npx vitest run \
  test/unit/srv/admin-service-explainer-actions.test.js \
  test/unit/srv/lib/explainer-generator.test.js \
  2>&1 | tail -10
```

Expected: all tests pass. Count should be ~10 (5 orchestrator + 4 CDS-pinning + N handler-behavior).

### Step 2: Run the full unit suite to confirm no regressions

```bash
npm test 2>&1 | grep -E "Test Files|Tests" | tail -3
```

Expected: same pre-existing failure count as PR 1 / PR 2 (known flakes per project memory). The new tests add to the pass count; no new failures.

### Step 3: Verify CDS compiles cleanly

```bash
npx cds compile srv/admin-service.cds --to json 2>&1 | tail -5
```

Expected: clean.

### Step 4: No commit (verification step).

---

## Definition of done

- [ ] All 7 tasks committed with their tests passing locally (Task 8 verification only)
- [ ] `npm test` passes (no new failures beyond the known-flake set from project memory)
- [ ] The three OData actions are callable via `POST /admin/generateVerbExplainers` etc. (verifiable with curl + admin auth post-deploy)
- [ ] `git log --oneline` shows 7 commits, each with `feat(#759)` / `test(#759)` / `build(#759)` / `docs(#759)` prefix
- [ ] `git status --short` is clean
- [ ] Plan reviewer subagent approves
- [ ] PR opened against `main` with a body referencing PR 1 (#776) and PR 2 (#780) merged predecessors

---

## Out-of-scope reminders

These are explicitly NOT in PR 3a — defer to PR 3b or later:

- **Admin Fiori apps** (`app/admin/verb-definitions/`, `app/admin/shelf-definitions/`) — PR 3b
- **`@UI.Facets` annotations** for the new fields on `HomepageShelves` object page — PR 3b
- **Side-nav grouping in admin-shell** for the new apps — PR 3b
- **CRUD lockdown via `@Capabilities.InsertRestrictions` / `DeleteRestrictions` on the two singleton-set entities** — PR 3b (the entities currently allow full CRUD via OData; that's fine for PR 3a because the actions don't insert/delete)
- **Bulk seed run against DEV** — PR 4 (operational)
- **PROD cutover** — PR 5 (operational)

---

## Plan-review loop

After all 7 tasks are committed, the plan-execution skill dispatches a plan-document-reviewer subagent to verify completion. If issues are found, the implementer iterates. Loop max 3 iterations.

This plan itself is reviewed by a plan-document-reviewer subagent before execution starts — see the next step in the writing-plans skill.
