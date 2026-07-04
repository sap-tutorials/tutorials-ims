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

The plugin is a root-level runtime dependency. `mbt build` copies it into `gen/srv/node_modules` via `npm install` in the srv module. No changes to `.deploy/mta.yaml` are required. The `srv-qa` module is a separate standalone package (its `package.json` is hand-authored, not derived from root) — it does not load `@cap-js/ai` and does not need the `aicore` binding.

The `aicore` managed service instance (`tutorials-aicore`, plan `extended`) is declared in `.deploy/mta.yaml` and bound to `tutorials-srv` on DEV. QA / PROD spaces must have the same binding before this plugin can serve recommendations in those environments.

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
