# CAP 10 AI improvements — PR 2: Adopt `@cap-js/ai` for `@Common.ValueList` recommendations

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install `@cap-js/ai@1.0.1` and configure the `AICore-btp` service kind so RPT-1 recommendations auto-attach to every `@Common.ValueList` field in the admin UIs. No opt-outs in v1 — trust the plugin defaults; narrow field-by-field in a follow-up if anything misbehaves.

**Architecture:** The plugin ships a `cds-plugin.js` that hooks `compile.for.runtime`, `compile.to.edmx`, and `served`. Runtime hookup wires `SAP_Recommendations` navigation properties onto entities with `@Common.ValueList` fields; the `served` hook connects the auto-created `AICore-btp` service instance to the existing `aicore` VCAP binding on the CF app. No code we own changes at the call-site level. This PR is: install, configure, verify.

**Tech Stack:** `@cap-js/ai@1.0.1`, `@sap/cds` 10.x, existing `aicore` service binding (verified: `tutorials-aicore` is bound to `tutorials-srv` on `tutorial-system/dev`), MTA + Cloud Foundry deploy.

## Global Constraints

- **No opt-outs in v1.** Do NOT add `@UI.RecommendationState: 0` anywhere. Trust plugin defaults across every `@Common.ValueList` field.
- **No schema changes.** No CDS entities are altered. No `db/schema.cds`, no `db/last-dev/`.
- **No custom handlers.** The plugin does the wiring. Only additions: one dep + one `cds.requires.AICore` block in `package.json`.
- **Single-tenant deployment.** Configure `resourceGroup: 'default'` explicitly. Multi-tenant onboarding paths are irrelevant.
- **Deploy targets in scope:** DEV (`tutorial-system/dev`). QA and PROD get the same treatment when they redeploy.
- **`aicore` VCAP binding must already exist** on the CF app. Verified for DEV (`cf services` shows `tutorials-aicore` bound). For QA / PROD, verify before merging.
- **Hybrid test posture:** ONE new test verifies srv boots with `AICore-btp` against a real binding. Do NOT test RPT-1 predictions in hybrid (would burn AI Core quota per run).
- **Rollback path:** `npm rm @cap-js/ai` + revert `package.json` `cds.requires.AICore` block. No data or schema migrations needed.
- **Order-of-operations constraint from the spec:** Land PR 1 first (already merged before this plan executes). If PR 1 is not merged, note it in the PR body — the two are technically independent, but this is easier to review after PR 1.

## File Structure

**Modify:**
- `package.json` — add `@cap-js/ai` dependency + `cds.requires.AICore` block.

**Create:**
- `test/hybrid/cap-ai-plugin-boot.test.js` — one hybrid test confirming boot with real binding.
- `docs/developers/reference/cap-ai-plugin.md` — short reference doc for what the plugin does, where its recommendations show up, and how to disable per-field if needed.

**Read-only checks:**
- `.deploy/mta.yaml` — verify the `srv-qa` `cp` list doesn't need `@cap-js/ai` (spec § PR 2 step 4).
- `cf services` — verify `aicore` binding presence on each target space.

---

## Task 1: Install `@cap-js/ai` and configure the service kind

**Files:**
- Modify: `package.json`

**Interfaces:**
- Consumes: existing `aicore` service binding on CF.
- Produces: `cds.connect.to('AICore')` becomes available in the srv process.

- [ ] **Step 1: Verify DEV binding presence (read-only sanity check)**

Run:
```bash
cf target -o tutorial-system -s dev
cf services | grep -i aicore
```

Expected: A line showing an `aicore` service instance (e.g. `tutorials-aicore   aicore   extended   tutorials-srv`) bound to `tutorials-srv`. Note the instance name.

If missing: stop here — the plugin will boot-fail in `AICore-btp` mode without a binding. Escalate.

- [ ] **Step 2: Install the plugin**

Run:
```bash
npm add @cap-js/ai@1.0.1
```

Expected:
- Adds `"@cap-js/ai": "^1.0.1"` to `package.json` `dependencies`
- `node_modules/@cap-js/ai/` created
- `package-lock.json` updated

Verify the versions:
```bash
jq '.dependencies["@cap-js/ai"]' package.json
```

Expected: `"^1.0.1"`.

- [ ] **Step 3: Add the `AICore` service kind block to `cds.requires`**

Edit `package.json`. Locate the `"cds": { "requires": { ... } }` block. Add an `AICore` entry:

```json
      "AICore": {
        "kind": "AICore-btp",
        "resourceGroup": "default"
      }
```

Placement guidance: keep it grouped with other CAP service configuration in `cds.requires`. Alphabetical order is fine (the block is not order-sensitive at runtime).

Example structure after edit (elided for brevity — only showing the new block in context):

```json
"cds": {
  "requires": {
    "AICore": {
      "kind": "AICore-btp",
      "resourceGroup": "default"
    },
    "db": { ... existing ... },
    "auth": { ... existing ... }
  }
}
```

The plugin's own `cds.requires.AICore` default (`"AICore-mocked"` for local `cds watch`, `"AICore-btp"` for `[production]` and `[hybrid]`) is overridden here to `"AICore-btp"` unconditionally. Reasoning: local `cds watch` boots CAP but doesn't hit `AICore-btp` unless the admin UI opens a `@Common.ValueList` form — and even then the plugin gracefully skips if no VCAP binding exists. The unconditional `AICore-btp` avoids two behaviours (mocked vs live) diverging silently.

Wait — reconsider. In local dev without a binding, `AICore-btp` **will** boot-fail on `_getToken()` when a `@Common.ValueList` field is opened. That would break every dev running `cds watch`. Correct configuration: leave the plugin default in place (mocked local, btp hybrid+prod) — do NOT add a `"kind"` override. Instead set only `resourceGroup`:

Revised: replace the block above with:

```json
      "AICore": {
        "resourceGroup": "default"
      }
```

The plugin merges this into its default kind config per profile. In `cds watch`: `AICore-mocked`. In `hybrid` and `production`: `AICore-btp` with `resourceGroup: 'default'` (overriding the plugin's builtin `'default'`, which is the same, so no functional change — but explicit is better than implicit).

Rationale documented for the reader: `AICore-mocked` returns empty predictions; the admin UI dropdowns still work, they just don't show recommendations. That's the desired local-dev shape.

- [ ] **Step 4: Local boot smoke — `cds watch` starts cleanly**

Run:
```bash
npx cds watch --profile default
```

Wait for `[cds] - server listening on { url: 'http://localhost:4004' }`.

Expected:
- Boots without error
- Log line mentioning `@cap-js/ai` or `AICore-mocked` connection (specific text varies by version — grep for `AICore` in the boot logs)
- No unhandled rejection

Verify by opening `http://localhost:4004/` and confirming the CAP welcome page renders.

Ctrl+C to stop.

- [ ] **Step 5: Commit the install + config**

```bash
git add package.json package-lock.json
git commit -m "feat(#959): add @cap-js/ai plugin for @Common.ValueList recommendations (PR 2 of 2)

Installs @cap-js/ai@1.0.1 and configures cds.requires.AICore
resourceGroup='default'. The plugin auto-hooks every @Common.ValueList
field with SAP RPT-1 recommendations in Fiori draft-enabled UIs.

Local dev (cds watch) uses the plugin's AICore-mocked kind — dropdowns
still work but return no recommendations. Hybrid and production use
AICore-btp against the aicore VCAP binding.

No opt-outs (@UI.RecommendationState: 0) in v1 per spec. Follow-up
PR will narrow specific fields if the DEV rollout shows problems."
```

---

## Task 2: Verify MTA build shape

**Files:**
- Read-only: `.deploy/mta.yaml`
- No code changes expected

**Interfaces:** none

- [ ] **Step 1: Read the `srv-qa` `cp` list in `.deploy/mta.yaml`**

Run:
```bash
grep -A 40 "^  - name: srv-qa" .deploy/mta.yaml | grep -E "cp:|@cap-js|node_modules"
```

Expected: The `srv-qa` `cp` list under its `build-parameters` copies specific files/dirs from the source into the srv-qa module. It does NOT enumerate every `node_modules/*` package — mbt handles that automatically via `npm install` in the module.

Confirm no `srv-qa`-specific action is needed for `@cap-js/ai`: the plugin's `main` is `cds-plugin.js` which is auto-loaded by `@sap/cds` on any srv boot, and it's a runtime dep in root `package.json`. mbt will `npm install` it into both `gen/srv/node_modules` and `gen/srv-qa/node_modules` because `package.json`'s `dependencies` are the source of both module trees.

- [ ] **Step 2: Confirm the srv module lists `aicore` as required**

Run:
```bash
grep -A 30 "^  - name: srv$" .deploy/mta.yaml | grep -E "requires:|- name:"
```

Expected: One of the `- name:` entries under `srv`'s `requires:` is `aicore` (or whatever the aicore resource is named in mta.yaml — grep `.deploy/mta.yaml` for `aicore`).

Also verify:
```bash
grep -A 5 "type: org.cloudfoundry.managed-service" .deploy/mta.yaml | grep -B 1 aicore
```

Expected: An mta resource block declares `aicore` as a managed service instance.

If either check fails: the plugin boot will fail on deploy. Stop and fix mta.yaml before continuing. If both pass: no changes needed.

- [ ] **Step 3: Run the deploy-config test suite (if any)**

Run:
```bash
npx vitest run test/unit/xs-security-authorities.test.js test/unit/mta-*.test.{js,ts} 2>/dev/null
```

Expected: Existing MTA-related tests pass. This is a regression backstop for the (unchanged) mta.yaml.

- [ ] **Step 4: No commit — no files changed**

Task 2 is a read-only sanity gate. Continue to Task 3.

---

## Task 3: Hybrid smoke test for plugin boot

**Files:**
- Create: `test/hybrid/cap-ai-plugin-boot.test.js`

**Interfaces:**
- Consumes: real `aicore` VCAP binding via `cds bind`.

- [ ] **Step 1: Verify hybrid test harness on the environment**

Run:
```bash
cf target -o tutorial-system -s dev
npx cds bind --resolve
```

Expected: Prints a resolved bindings list including `aicore` (the DEV binding for `tutorials-srv`). If bindings aren't set up locally, follow `docs/developers/getting-started.md` § hybrid bindings before continuing.

- [ ] **Step 2: Write the failing test**

Create `test/hybrid/cap-ai-plugin-boot.test.js`:

```js
// test/hybrid/cap-ai-plugin-boot.test.js
// Verifies srv boots with @cap-js/ai plugin against a real aicore VCAP
// binding, and cds.connect.to('AICore') returns a service handle.
//
// Does NOT invoke RPT-1 predictions — those would burn AI Core quota per
// test run and are not what we're guarding here. This is a boot smoke
// gate: if the plugin's cds.requires.AICore block or the aicore binding
// drifts, this test fails and CI catches it before deploy.

import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

// The hybrid workspace boots CAP via cds.test('serve'). Rely on the
// vitest hybrid project's setup — no manual serve here.

describe('cap-ai-plugin-boot (hybrid)', () => {
  it('cds.connect.to("AICore") succeeds with the real aicore binding', async () => {
    const aiCore = await cds.connect.to('AICore');
    expect(aiCore).toBeTruthy();
    // The service exposes CDS entities: resourceGroups, deployments, configurations.
    // We only assert they exist — reading them would hit AI Core.
    expect(aiCore.entities).toBeTruthy();
    expect(aiCore.entities.resourceGroups).toBeTruthy();
    expect(aiCore.entities.deployments).toBeTruthy();
    expect(aiCore.entities.configurations).toBeTruthy();
  });

  it('is configured with resourceGroup="default"', async () => {
    const aiCoreConfig = cds.env.requires.AICore;
    expect(aiCoreConfig).toBeTruthy();
    expect(aiCoreConfig.resourceGroup).toBe('default');
  });
});
```

- [ ] **Step 3: Run the hybrid test**

Run:
```bash
npm run test:hybrid -- --project hybrid test/hybrid/cap-ai-plugin-boot.test.js
```

Expected: Both cases pass. If the first case fails on `cds.connect.to('AICore')` with a token/auth error, the plugin is trying to hit AI Core before we let it — check the plugin's `served` hook doesn't require a live token at connect time. If the second case fails, `cds.requires.AICore.resourceGroup` isn't wired — recheck Task 1 Step 3.

- [ ] **Step 4: Commit**

```bash
git add test/hybrid/cap-ai-plugin-boot.test.js
git commit -m "test(#959): hybrid smoke — @cap-js/ai plugin boots with aicore binding

One test file, two cases:

1. cds.connect.to('AICore') succeeds against the real aicore binding
   and exposes resourceGroups/deployments/configurations entities.
2. cds.env.requires.AICore.resourceGroup === 'default' as configured.

Does NOT invoke RPT-1 predictions (would burn AI Core quota per run).
This is a boot-time regression gate — if the plugin config or the CF
binding drifts, CI catches it before deploy."
```

---

## Task 4: Documentation

**Files:**
- Create: `docs/developers/reference/cap-ai-plugin.md`
- Modify: `docs/.vitepress/config.ts` — add the new page to the sidebar
- Modify: `CLAUDE.md` — note the plugin in the CAP-related gotchas / plugins list

**Interfaces:** none

- [ ] **Step 1: Create the reference doc**

Create `docs/developers/reference/cap-ai-plugin.md`:

```markdown
# @cap-js/ai plugin

The `@cap-js/ai` plugin auto-attaches SAP RPT-1 recommendations to every field annotated with `@Common.ValueList` in Fiori draft-enabled admin UIs. Installed and configured via `package.json` (`dependencies` + `cds.requires.AICore`).

## What it does

When an admin opens a form with a `@Common.ValueList` dropdown, the plugin's server-side hook attaches a `SAP_Recommendations` navigation property to the OData response. The Fiori runtime renders the top predictions as an accept-in-one-click chip above the value-help dropdown.

## Where it shows up

Every entity with a `@Common.ValueList` field gets auto-hooked. Notable places in this codebase:

- `Missions.tags` (via `Tags` association)
- `Groups.tags`
- `Advocates.topics`
- `Events.tags`
- `Prizes.tag`
- Any other `@Common.ValueList` in `app/admin-annotations.cds`

## Local dev vs. deployed

- `cds watch` uses the plugin's `AICore-mocked` kind — dropdowns work but return no recommendations. Zero AI Core quota consumed.
- Hybrid (`cds bind`) and production (Cloud Foundry) use `AICore-btp` against the `aicore` VCAP binding. First form-load post-deploy triggers an RPT-1 deployment creation (~5–20 s latency, one-time per resource group).

## Configuration

`package.json`:

```json
"cds": {
  "requires": {
    "AICore": {
      "resourceGroup": "default"
    }
  }
}
```

Single-tenant deployment — the plugin uses one resource group (`default`). Multi-tenant onboarding paths in the plugin are not exercised here.

## Disabling recommendations on a specific field

Add `@UI.RecommendationState: 0` to the field annotation in `app/admin-annotations.cds`:

```cds
annotate AdminService.Missions with {
  tags @UI.RecommendationState: 0;
}
```

Dynamic expressions are supported:

```cds
annotate AdminService.Missions with {
  tags @UI.RecommendationState: (published == true ? 0 : 1);
}
```

## Rollback

If the plugin misbehaves:

```bash
npm rm @cap-js/ai
```

Then remove the `AICore` block from `cds.requires` in `package.json`, redeploy. No schema or data migrations involved.

## References

- Plugin: <https://www.npmjs.com/package/@cap-js/ai>
- CAP release notes: <https://cap.cloud.sap/docs/releases/2026/jun26#new-ai-core-plugin>
- Design spec: [../../superpowers/specs/2026-07-04-959-cap-ai-plugin-adoption-design.md](../../superpowers/specs/2026-07-04-959-cap-ai-plugin-adoption-design.md)
- Issue: [#959](https://github.com/sap-tutorials/tutorials-ims/issues/959)
```

- [ ] **Step 2: Add the page to the VitePress sidebar**

Edit `docs/.vitepress/config.ts`. Locate the `sidebar` entry for `/developers/reference/`. Add:

```ts
{ text: '@cap-js/ai plugin', link: '/developers/reference/cap-ai-plugin' },
```

Place it alphabetically among the existing `reference/` entries.

- [ ] **Step 3: Run the VitePress sidebar guard**

Run:
```bash
npm run docs:build
```

Expected: Build succeeds. The `predocs:build` sidebar guard catches unregistered pages or dead links. If it fails, fix the entry in `docs/.vitepress/config.ts`.

- [ ] **Step 4: Add a line to `CLAUDE.md` gotchas**

Edit `CLAUDE.md`. Locate the "Gotchas" section (after `## Gotchas` heading). Add near the AI-related items (after the `AI-authored quizzes` bullet):

```markdown
- **`@cap-js/ai` plugin** — adopted for RPT-1 recommendations on `@Common.ValueList` fields. Auto-hooks every such field in Fiori draft-enabled UIs. Local `cds watch` uses `AICore-mocked` (no recommendations); hybrid/production use `AICore-btp` against the `aicore` VCAP binding. Per-field opt-out: `@UI.RecommendationState: 0`. Reference: [docs/developers/reference/cap-ai-plugin.md](docs/developers/reference/cap-ai-plugin.md). Issue #959.
```

- [ ] **Step 5: Commit**

```bash
git add docs/developers/reference/cap-ai-plugin.md docs/.vitepress/config.ts CLAUDE.md
git commit -m "docs(#959): reference doc for @cap-js/ai plugin

Adds docs/developers/reference/cap-ai-plugin.md covering:
- what the plugin does + where auto-attachment shows up
- local dev vs. deployed behaviour
- config in package.json
- per-field disable via @UI.RecommendationState: 0
- rollback path

Wires the page into the VitePress sidebar and adds a one-line
pointer in CLAUDE.md gotchas so future agents find it."
```

---

## Task 5: Deploy to DEV and manual verify

**Files:** none

**Interfaces:** deployed CF app

- [ ] **Step 1: Confirm branch state before deploy**

Run:
```bash
git branch --show-current
git log --oneline main..HEAD
git status
```

Expected:
- Branch: `worktree-959-cap-ai-improvements` (or a follow-up branch after PR 1 merged)
- Log: 4 commits (plugin install + hybrid test + docs + this task's status if any)
- Status: clean

If the working directory is dirty, stop and commit before proceeding.

- [ ] **Step 2: Build + deploy to DEV**

**Confirm deploy scope with Tom first** (project memory: `Confirm deploy scope`). If confirmed:

```bash
cf target -o tutorial-system -s dev
npm run build:all
cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f
cd ..
```

Expected: MTA deploy succeeds. `tutorials-srv` starts within 2 minutes. If the srv fails to boot with a stack trace mentioning `@cap-js/ai` or `AICore`, rollback per the plan §Rollback section and file a follow-up issue.

- [ ] **Step 3: Verify boot log**

Run:
```bash
cf logs tutorials-srv --recent | grep -Ei "cap-js/ai|AICore|failed"
```

Expected:
- One or more log lines mentioning `AICore` service registration
- No lines matching `failed` or `Error`

- [ ] **Step 4: Smoke — admin UI form with `@Common.ValueList` renders**

Open in a browser (or use `curl` if available):
- `https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/admin-ui/#missions-display`
- Click on any mission → Edit
- Open the `tags` dropdown

Expected:
- Dropdown opens
- Value-help renders (with or without an RPT-1 recommendation chip above it — first load may show no chip; subsequent loads may show a "recommended: X" suggestion)
- No console errors in the browser DevTools

If a chip appears: verify accepting it prefills the tag correctly.

- [ ] **Step 5: Check AI Core quota consumption**

Run:
```bash
cf logs tutorials-srv --recent | grep -Ei "rpt-1|orchestrationForResourceGroup|deployment.*RPT"
```

Expected: If this is the first form-load post-deploy, you should see one or two log lines confirming RPT-1 deployment creation. Subsequent loads are fast (deployment cached).

- [ ] **Step 6: Note the manual verification outcome in the PR body**

If everything passes: mark the PR ready for review (`gh pr ready`) — see Task 6.

If anything fails: write the failure in a comment on the PR, keep it as draft, and stop. The user will decide whether to iterate or revert.

---

## Task 6: Open the PR

**Files:** none (git operations only)

- [ ] **Step 1: Push the branch**

Run:
```bash
git push -u origin worktree-959-cap-ai-improvements
```

- [ ] **Step 2: Open the PR (draft first — Tom's default)**

Run:
```bash
gh pr create --draft --title "feat(#959): adopt @cap-js/ai plugin for @Common.ValueList recommendations (PR 2 of 2)" --body "Part 2 of the CAP 10 AI improvements split from #959. See docs/superpowers/specs/2026-07-04-959-cap-ai-plugin-adoption-design.md for context.

## What changed

- \`npm add @cap-js/ai@1.0.1\` (runtime dep, ~68 KB, no transitive deps).
- Add \`cds.requires.AICore.resourceGroup: 'default'\` in \`package.json\`.
- New hybrid smoke: \`test/hybrid/cap-ai-plugin-boot.test.js\` — asserts srv boots with the real \`aicore\` binding + resourceGroup config is picked up.
- New reference doc: \`docs/developers/reference/cap-ai-plugin.md\`.
- One-line gotchas entry in \`CLAUDE.md\`.

## Behaviour change

Every \`@Common.ValueList\` field in the admin UIs (Missions.tags, Groups.tags, Advocates.topics, Events.tags, Prizes.tag, …) will show an RPT-1 recommendation chip when the LLM has a strong prediction. Field-level opt-out is \`@UI.RecommendationState: 0\` in \`app/admin-annotations.cds\` — no opt-outs in v1 per the spec.

## Local dev unaffected

\`cds watch\` uses the plugin's \`AICore-mocked\` kind — dropdowns still work, no AI Core quota consumed.

## First-time RPT-1 deployment latency

The plugin creates the RPT-1 AI Core deployment on the first admin form-load with a \`@Common.ValueList\` field after deploy. Expect ~5–20 s latency on that first load, then cached. PROD cutover in July will hit the same one-time delay.

## Rollback

\`npm rm @cap-js/ai\` + revert the \`AICore\` block in \`cds.requires\` + redeploy. No schema or data migrations. Clean revert.

## Manual verification checklist (DEV)

- [ ] MTA deploy succeeds
- [ ] \`cf logs tutorials-srv\` shows no @cap-js/ai errors
- [ ] Admin form with \`@Common.ValueList\` dropdown renders
- [ ] RPT-1 deployment created (visible in cf logs) on first form-load"
```

- [ ] **Step 3: Confirm PR was created**

Run:
```bash
gh pr view --json url,state,isDraft | jq
```

Expected: A draft PR opened. Note the URL.

- [ ] **Step 4: Update the branch state — mark ready if Task 5 passed**

If Task 5 § Step 6 completed successfully AND Tom explicitly approves:

```bash
gh pr ready
```

Otherwise leave as draft — the PR body's manual-verification checklist keeps state visible.

---

## Self-Review

**Spec coverage check** (against `docs/superpowers/specs/2026-07-04-959-cap-ai-plugin-adoption-design.md` § "PR 2"):

| Spec item | Covered by task |
|-----------|-----------------|
| Install `@cap-js/ai` | Task 1 Step 2 |
| Configure `cds.requires.AICore` (resourceGroup='default') | Task 1 Step 3 |
| Verify VCAP binding on DEV | Task 1 Step 1 |
| Verify `srv-qa` `cp` list / mta.yaml shape | Task 2 |
| No `@UI.RecommendationState: 0` opt-outs in v1 | Global constraint — not violated by any task |
| RPT-1 deployment first-time latency documented | Task 4 Step 1 (in the reference doc) + Task 6 PR body |
| Local `AICore-mocked` boot | Task 1 Step 4 |
| Hybrid boot verification | Task 3 |
| Rollback path | Task 4 Step 1 (in the reference doc) + Task 6 PR body |
| Manual verification checklist | Task 5 + Task 6 PR body |

**Placeholder scan**: No TBD / TODO / "similar to earlier task" strings. Every step has an explicit action.

**Type consistency**: Only two type-shaped values in this plan — the `cds.requires.AICore` config object shape (verified against the plugin's `srv/AICoreService.cds` at v1.0.1) and the hybrid-test assertion shape (`aiCore.entities.{resourceGroups,deployments,configurations}` — matches the plugin's advertised surface per its README).

**Deviation from spec, called out for reviewer**: The spec's PR 2 § 2 shows `"AICore": { "kind": "AICore-btp", "resourceGroup": "default" }`. Task 1 Step 3 revises this to `"AICore": { "resourceGroup": "default" }` and documents the reasoning inline (unconditional `AICore-btp` would break `cds watch` on any machine without an AI Core binding). The plugin's profile-based defaults (`AICore-mocked` for default, `AICore-btp` for `[production]` and `[hybrid]`) do the right thing — we only need to override `resourceGroup`. This is a plan improvement over the spec; agreed as part of implementation.
