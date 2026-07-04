# Design — CAP 10 AI improvements: consolidate resolution + adopt `@cap-js/ai` for recommendations

Issue: [#959](https://github.com/sap-tutorials/tutorials-ims/issues/959)
Date: 2026-07-04
Author: Tom (via brainstorming with Claude)

## Context

Issue #959 proposed swapping the seven `@sap-ai-sdk/*` direct imports in `srv/lib/*.js` for equivalent calls through the new `@cap-js/ai` plugin's `AICore` service.

**Scope correction.** Probing `@cap-js/ai@1.0.1` (unpacked from npm) revealed the plugin's actual surface is:

- UI Recommendations via SAP RPT-1 (auto-hooks `@Common.ValueList` fields)
- Admin CRUD on `resourceGroups`, `deployments`, `configurations` via `cds.ql`
- Helper functions `resourceGroupForTenant()`, `rpt1DeploymentId()`, `stop()`
- Multi-tenant resource-group management (irrelevant to us — we're single-tenant)

The plugin does **not** expose a `chatCompletion`, `stream`, or `embed` API. There is an unexported internal helper `orchestrationForResourceGroup` in `srv/ai-core/deployments.js` that resolves an orchestration deployment ID, but no wrapper that actually calls the orchestration endpoint. The seven direct-import files remain the correct home for `new OrchestrationClient(...)` and `AzureOpenAiEmbeddingClient` at v1.0.1.

We therefore reshape #959 into two independent PRs that ship the real value hidden in the ticket:

1. **PR 1** — consolidate configuration resolution (the code-hygiene win the ticket describes)
2. **PR 2** — adopt `@cap-js/ai` for `@Common.ValueList` recommendations (the "bonus" item in the ticket, but the plugin's actual value-add at v1.0.1)

## Non-goals

- Changing any prompt, model choice, evaluation logic, or streaming shape
- Modifying `srv/lib/chat-orchestrator.js`'s tool-dispatch loop
- Introducing a `srv/lib/ai-client.js` wrapper (premature — plugin's future shape is unknown; revisit once the plugin grows a chat API)
- Multi-tenant onboarding (out of scope; we're single-tenant)
- Filing an upstream PR to `cap-js/ai` for a chat wrapper (out of scope for this issue; possible follow-up)

---

## PR 1 — Consolidate AI configuration resolution

### Goal

One place resolves the three configuration inputs an AI Core call needs:

- LLM `modelName` (`ChatSettings.modelName` → env → hardcoded)
- LLM `deploymentId` (`ChatSettings.deploymentId` → env → throws)
- Embedding `model` (`ChatSettings.embeddingModel` → env → hardcoded default)

Future SDK swaps or plugin adoption touch one file (`srv/lib/chat-settings-resolver.js`).

### Changes

**1. `srv/lib/chat-settings-resolver.js` — add `resolveEmbeddingSettings()`**

Extract a private `readChatSettings()` helper for the tolerant CDS-or-raw-SQL read (currently inlined in `resolveChatLlmSettings`). Add a second exported function:

```js
/**
 * Resolve embedding model. There is no embeddingDeploymentId column —
 * @sap-ai-sdk/foundation-models resolves the deployment from the model
 * name via the aicore binding.
 *
 * Fallback chain:
 *   ChatSettings.embeddingModel → CHAT_EMBEDDING_MODEL env → 'text-embedding-3-small'
 *
 * @returns {Promise<{ model: string }>}
 */
export async function resolveEmbeddingSettings() { ... }
```

The existing `resolveChatLlmSettings()` continues to throw on unresolvable `deploymentId` (that's the #318 fix and we keep it).

**2. `srv/lib/category-classifier-llm.js` — replace inline resolver (~30 lines)**

Delete the inline `let settings = null; try { ... }` block at lines ~60–95. Replace with:

```js
const { modelName, deploymentId } = await resolveChatLlmSettings();
```

Same behaviour — the extracted resolver has the identical fallback chain.

**3. `srv/lib/os-variant-generator.js` — delete `resolveSettings()` function**

Function-scope duplicate of the same resolver body. Replace call sites with `await resolveChatLlmSettings()`.

**4. `srv/lib/explainer-generator.js` — use resolver, drop hardcoded model**

Currently hardcodes `DEFAULT_MODEL = 'anthropic--claude-4.6-sonnet'` and passes `{}` as the second arg to `OrchestrationClient` (relying on SDK env-passthrough for `deploymentId`).

Change to:

```js
const { modelName, deploymentId } = await resolveChatLlmSettings();
// ... build client with modelName in promptTemplating.model.name
const client = new OrchestrationClient(config, { deploymentId });
```

**Behaviour change:** admins can now steer the explainer model via `/admin-ui/#joule-settings`, matching every other LLM call site in the app. Downside: an admin who picks a model without rates in `_token-cost.js` will get a `"no rates for model 'X'"` throw on cost calculation. This is a pre-existing failure mode of every other LLM call in the app — parity is the right move.

The three prompt files (`prompts/explainer-{verb,shelf,shelf-entry}.md`) stay unchanged. The forced tool-call shape (`tool_choice: 'submit_explainer'`) stays unchanged.

**5. `srv/lib/embedding-client.js` — no signature change**

`embed(inputs, model)` stays as-is. The consolidation happens at the **callers**: every code path that currently reads `ChatSettings.embeddingModel` themselves calls `resolveEmbeddingSettings()` instead. Known callers to update:

- `srv/lib/chat-orchestrator.js:601-604` — in `expandSearchConcepts` dispatch
- `srv/lib/embedding-query.js` — RAG pipeline
- `srv/jobs/concept-embedding-backfill.js` — cron job
- `srv/lib/category-seed-embeddings.js` — category classifier seeder
- Any other `ChatSettings.*embeddingModel` reader (grep before finalizing the diff)

**6. `srv/lib/chat-orchestrator.js` `streamChat()` — no change to `deploymentId` handling**

`streamChat` receives `deploymentId` and `modelName` as params from `srv/chat-service.js`, which resolves them per-request (letting the request body override for admin testing). Pulling `resolveChatLlmSettings()` inside `streamChat` would break that override path. Correct pattern already.

### Zero-regression check

Post-refactor grep should show these tokens ONLY inside `srv/lib/chat-settings-resolver.js`:

```
settings?.MODELNAME
settings?.DEPLOYMENTID
CHAT_MODEL_NAME
CHAT_DEPLOYMENT_ID
CHAT_EMBEDDING_MODEL
'text-embedding-3-small' (as a fallback literal)
'anthropic--claude-4.6-sonnet' (as a fallback literal)
```

### Tests

Unit — `srv/lib/__tests__/chat-settings-resolver.test.js`:
- Verify the file exists; if not, add it. Cover the two-mode DB read (cds.entities present vs. build-pipeline raw SQL) + all four fallback branches for `resolveChatLlmSettings`, plus the three-branch chain for `resolveEmbeddingSettings`.
- Add a case: `resolveChatLlmSettings` throws with the diagnostic message when both `ChatSettings.deploymentId` and `CHAT_DEPLOYMENT_ID` are unset.

Unit — existing tests for the four refactored files (`ai-quiz-llm.js`, `code-check-llm.js`, `category-classifier-llm.js`, `os-variant-generator.js`, `explainer-generator.js`):
- Mock `chat-settings-resolver.js` at the module boundary. Verify the LLM-call shape (prompt, tools, tool_choice) is unchanged compared to `main`.

Hybrid — no new hybrid tests. The resolver already exercises against HANA via existing hybrid tests that trigger AI-call paths.

### Rollback

Revert the PR. No schema, no config, no dep changes — trivial.

---

## PR 2 — Adopt `@cap-js/ai` for `@Common.ValueList` recommendations

### Goal

Turn on RPT-1 recommendations for admin `@Common.ValueList` fields where the plugin's default (recommendations on) makes sense. No opt-outs in v1 — trust the plugin's defaults; narrow later if a specific field misbehaves.

### Changes

**1. Install**

```bash
npm add @cap-js/ai
```

Adds ~68 KB unpacked, zero runtime deps (`peerDependencies: { "@sap/cds": ">=9" }`).

**2. Configure the CAP service kind — `package.json`**

Add to `cds.requires`:

```json
"AICore": {
  "kind": "AICore-btp",
  "resourceGroup": "default"
}
```

The plugin declares `AICore-mocked` as the default kind and `AICore-btp` under `[production]` and `[hybrid]` profiles, so local `cds watch` gets mock mode automatically. We override to `AICore-btp` explicitly here so hybrid + prod both light up.

**3. Verify VCAP binding on all deploy targets**

The plugin auto-resolves the AI Core binding via `vcap.label: 'aicore'`. Confirm:

- DEV (`tutorial-system/dev`): `cf services` shows `aicore` service instance bound to `tutorials-srv`
- QA (once created): same
- PROD (July cutover): same

If a target lacks the binding, `AICore-btp` boot fails hard. Document in the PR description; catch in the smoke suite.

**4. `.deploy/mta.yaml` — no dep changes needed**

`@cap-js/ai` is a `dependencies` entry in root `package.json`; mbt bundles it into `gen/srv/node_modules` on build. Verify the `srv-qa` `cp` list in `mta.yaml` doesn't need adjusting (plugin is required by srv, not srv-qa, but srv-qa boots the same CAP model — smoke-test both).

Confirm the CF app already has the `aicore` service bound (the app requirement) — this is a **read-only check**, not a change:

```yaml
modules:
  - name: tutorials-srv
    requires:
      - name: aicore
```

**5. No opt-out annotations in v1**

The plugin auto-hooks every `@Common.ValueList`. Do NOT add `@UI.RecommendationState: 0` anywhere in v1. Rationale (from brainstorm): let the plugin's defaults apply, watch for issues in DEV, narrow later. Places that will get auto-hooked (identified from `app/admin-annotations.cds`):

- `Missions.tags` (via `Tags` association) — reasonable
- `Groups.tags` — reasonable
- `Advocates.topics` — reasonable
- `Events.tags`, `Prizes.tag`, other tag pickers — probably reasonable
- Any `Common.ValueList` we haven't audited — accepted risk in v1

If a field misbehaves in DEV, follow-up PR adds `@UI.RecommendationState: 0` to that field only.

**6. AI Core RPT-1 deployment**

The plugin creates the RPT-1 deployment on first use (per `srv/ai-core/deployments.js:rpt1ForResourceGroup`). First admin form-load with a `@Common.ValueList` field after deploy will:

- See a small extra latency (~5–20 s for RPT-1 deployment creation)
- Consume a small amount of AI Core quota for RPT-1 (per-tenant, single-tenant = single deployment)

Document this in the PR body so the DEV smoke afterward doesn't get surprised. PROD cutover in July will hit the same first-time latency once.

### Tests

Unit — none. The plugin auto-hooks at `served` time; there's no code we own to unit-test.

Local — `cds watch` boots with `AICore-mocked` kind. Verify:
- Startup log line "connect using module ... MockAICoreService" (or equivalent)
- Admin UI loads (`/admin-ui/`) without console errors
- Value-help dropdown on a `@Common.ValueList` field opens without errors (mock returns empty predictions, dropdown falls back to normal value-help)

Hybrid — one new test file `test/hybrid/cap-ai-plugin-boot.test.js`:
- Verify srv boots with `AICore-btp` kind against a real `aicore` binding
- Verify `cds.connect.to('AICore')` succeeds
- Do NOT test RPT-1 predictions (would burn quota per run)

Smoke — existing `test/smoke/` suite. Add nothing new; existing `/admin-ui/` liveness check catches boot failures.

Manual verification (PR description checklist):
- Deploy to DEV
- Open `/admin-ui/#missions-display`, create a mission, verify tag picker still works
- Verify no error logs from `@cap-js/ai` in `cf logs tutorials-srv`
- Optional: try accepting a tag recommendation from the RPT-1 chip

### Rollback

If the plugin causes trouble:

```bash
npm rm @cap-js/ai
# Revert package.json cds.requires.AICore
# Redeploy
```

No schema changes, no data changes — clean revert. In-flight admin sessions may see one flash of "recommendation available" chips that go away on refresh.

### Risks

- **Latency on first admin form load** post-deploy — RPT-1 deployment creation. One-time; ~5–20 s. Document.
- **AI Core quota consumption** — RPT-1 has its own scenario; we haven't measured yet. Should be minor for admin traffic volume, but watch DEV quota after landing.
- **Plugin auto-hooks entities we didn't intend** — risk we accept in v1. Rollback is fast.
- **Multi-tenant migration** — plugin creates a resource group per tenant if we ever go multi-tenant. Currently no plan.

---

## Order of operations

1. Land **PR 1** first (consolidation). Zero user-visible change. Merges independently.
2. Land **PR 2** after PR 1 is deployed to DEV and validated for a few days.

Landing PR 2 first would work fine too — the two are independent. But PR 1 is the lower-risk starter.

## References

- Plugin unpacked: `/tmp/cap-ai-probe/package/` (v1.0.1)
- Plugin npm page: <https://www.npmjs.com/package/@cap-js/ai>
- Plugin docs: <https://cap.cloud.sap/docs/releases/2026/jun26#new-ai-core-plugin>
- Issue: <https://github.com/sap-tutorials/tutorials-ims/issues/959>
- Related past fix: issue #318 (deploymentId throw-not-null)
- Related past fix: issue #759 (AICORE_EXPLAINER_GENERATOR_DISABLED kill-switch)
