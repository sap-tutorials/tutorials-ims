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

Single-tenant deployment — the plugin uses one resource group (`default`). Multi-tenant onboarding paths in the plugin are not exercised here. The `kind` is left unset so the plugin's profile-based defaults apply: `AICore-mocked` for local dev (no binding needed), `AICore-btp` for `[hybrid]` and `[production]` (uses the `aicore` VCAP binding).

## MTA / deployment shape

The plugin is a root-level runtime dependency. `mbt build` copies it into `gen/srv/node_modules` via `npm install` in the srv module. The `srv-qa` module is a separate standalone package (its `package.json` is hand-authored, not derived from root) — it does not load `@cap-js/ai` and does not need the `aicore` binding.

The `aicore` managed service instance (`tutorials-aicore`, plan `extended`) is declared in `.deploy/mta.yaml` and bound to `tutorials-srv` on DEV. QA / PROD spaces must have the same binding before this plugin can serve recommendations in those environments.

### The `AICoreService` model MUST be in the srv build-task model list (#1276)

Since #1182 the deployed CF app loads a **precompiled, pinned `srv/csn.json`** (`srv/lib/strip-precompiled-plugin-roots.js` keeps model resolution at `files.length === 1`). The runtime model is therefore **exactly** the model list in the `.cdsrc.json` nodejs srv build task — anything not in that list is absent from the deployed model, even though the plugin still registers its handlers.

`AICore` is a **connect-time** model (the plugin does `cds.connect.to('AICore')` in its recommendations read-after-write handler); it is NOT a design-time `using` dependency of any srv `.cds`, so `cds build` never pulls it into the csn on its own. It must be listed explicitly:

```jsonc
// .cdsrc.json → build.tasks
{ "for": "nodejs", "src": "srv", "dest": "srv",
  "options": { "model": [ "srv", "db", "app",
    "@cap-js/data-inspector",
    "@cap-js/ai/srv/AICoreService",   // ← #1276: else admin draft Create 500s on CF
    "cds-caching/db/cache-store", "cds-caching/db/statistics" ] } }
```

Symptom if dropped: **every** admin draft Create on a `@Common.ValueList`-bearing entity 500s with `No service definition found for 'AICore'` — but **only on CF**. Every local test passes because `cds.test('serve', …)` compiles the model from source roots (plugin's `AICore` always present). Regression guard: `test/unit/built-csn-plugin-services.test.js`.

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

Then remove the `AICore` block from `cds.requires` in `package.json` and redeploy. No schema or data migrations involved. The existing `@sap-ai-sdk/*` direct-import call sites (chat, quiz, code-check, embeddings) are independent of this plugin and continue to work unchanged.

## References

- Plugin: <https://www.npmjs.com/package/@cap-js/ai>
- CAP release notes: <https://cap.cloud.sap/docs/releases/2026/jun26#new-ai-core-plugin>
- Design spec: [../../superpowers/specs/2026-07-04-959-cap-ai-plugin-adoption-design.md](../../superpowers/specs/2026-07-04-959-cap-ai-plugin-adoption-design.md)
- Issue: [#959](https://github.com/sap-tutorials/tutorials-ims/issues/959)

---

### #1034 exception: developer-relevance classifier does NOT use `@cap-js/ai`

The `srv/lib/relevance-classifier.js` module used by the SAP News developer-
relevance filter goes through `@sap-ai-sdk` (`AzureOpenAiEmbeddingClient`,
`OrchestrationClient`) directly rather than through `@cap-js/ai`. Reason:
the plugin's `AICore` `kind`-resolution fires on any draft-Create write with
`@Common.ValueList` fields and throws "No service definition for AICore"
when `cds.requires.AICore.kind` is unset at runtime (VCAP presence alone is
insufficient). Bypassing the plugin sidesteps that failure path entirely.
See also `MEMORY.md > cap-ai-plugin-aicore-kind-resolution`.
