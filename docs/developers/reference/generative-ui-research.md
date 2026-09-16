# Generative UI Research — MCP Apps & json-render

**Issue:** [sap-tutorials/tutorials-ims#2362](https://github.com/sap-tutorials/tutorials-ims/issues/2362) · Research spike, 2026-09-16.

Evaluates two 2025/2026 generative-UI technologies — **MCP Apps** and **json-render** — for developers.sap.com. Anchor use case is tutorial content; other portal surfaces considered. This is a scoping doc plus a scoped POC (use case #1); it does **not** commit either technology to the roadmap.

---

## TL;DR

- The portal is **already a generative-UI system in miniature** — a component catalog (`scripts/parsers/types.ts`), a JSON spec per page (`<script id="tutorial-data">`), and a renderer (the ~48 Vue islands). Both technologies are *evolutions* of that pattern, not foreign grafts.
- **json-render** (Vercel Labs) targets **our own web UI** — anonymous + logged-in visitors on the Vue frontend. Highest leverage, lowest conceptual distance. **Lead bet.**
- **MCP Apps** (official MCP extension) targets **external AI-client users** (Claude/Cursor/Copilot). The MCP server surface is already mature and has the exact seam to extend, so a prototype is cheap — but the audience is narrower and depends on host adoption. **Second, complementary bet.**
- They compose: json-render can *produce* a UI spec; MCP Apps can be the *delivery envelope* into AI clients. A shared Vue catalog could serve both.
- Recommendation: pursue both as **time-boxed, feature-flagged spikes** (house style: DB flags, fail-open, DEV-first). Do **not** rip out the current island pipeline.

---

## The two technologies

### json-render — [`vercel-labs/json-render`](https://github.com/vercel-labs/json-render)

Vercel Labs **Generative UI** framework (launched ~Mar 2026). An AI emits a **constrained JSON UI spec** — a flat tree of typed elements with props, children, bindings, and visibility conditions — rendered through a developer-defined **component catalog** (Zod-typed). The model is guardrailed to your primitives; it is **not** free-form code generation.

- **Three layers:** *Catalog* (declare components + actions with typed props) → *Schema* (per-framework rendering capabilities) → *Renderer* (registry maps catalog types to real components).
- **Multi-framework:** React, **Vue**, Svelte, Solid, React Native, plus PDF/email/image/CLI renderers.
- **Streaming:** progressive rendering via JSONL patches.
- **Also ships an MCP-server package** and AI-SDK / OpenAPI integrations.
- **Audience:** users of *our own* web app. Renders natively in the Vue-island frontend.

### MCP Apps — [`modelcontextprotocol/ext-apps`](https://github.com/modelcontextprotocol/ext-apps)

Official MCP extension (blog posts Nov 2025 + Jan 2026 spec). Lets an MCP **tool** return an interactive HTML **UI resource** that an MCP **host** renders inline.

- A tool declares `_meta.ui.resourceUri` → a `ui://` resource serving bundled HTML/JS. The host preloads it and renders it in a **sandboxed iframe**.
- Host ↔ iframe communicate over **JSON-RPC via `postMessage`**: the app can call back into MCP tools; the host can push fresh results.
- **Security:** sandboxed iframe — no parent-page or cookie access; hosts can render third-party apps without trusting the server author.
- **[mcp-ui](https://github.com/MCP-UI-Org/mcp-ui)** is the companion SDK (`@mcp-ui/server`, `@mcp-ui/client`) implementing the standard; framework-agnostic (React/Vue/Svelte/vanilla starter templates exist).
- **Audience:** developers talking to an AI host — **not** anonymous web visitors on developers.sap.com.

| | json-render | MCP Apps |
| --- | --- | --- |
| Renders where | Our own web UI (Vue islands) | External AI host, sandboxed iframe |
| Audience | Portal visitors (anon + auth) | Devs in Claude/Cursor/Copilot |
| Maturity | ~Mar 2026, Vercel Labs | Spec finalized Jan 2026 |
| Portal fit today | Direct — matches island pattern | Cheap prototype on existing MCP surface |
| Dependency risk | A Vue renderer dep | Host adoption of the extension |

---

## Where they fit the current architecture

### The tutorial rendering pipeline is already schema-driven

```text
markdown (sap-tutorials repos)
  → scripts/fetch-tutorials.ts → scripts/parsers/compose.ts
    → Hugo .md with steps[] frontmatter + shortcodes
      → hugo/layouts/tutorials/single.html
          emits  <script id="tutorial-data" type="application/json">  + empty mount divs
        → Vue islands (hugo-apps/src/*/main.ts) hydrate the mounts
          → gzip BLOB in HANA, served via CAP /content/tutorials/:slug
```

- **Catalog / schema source of truth:** [`scripts/parsers/types.ts`](../../../scripts/parsers/types.ts) — `TutorialStep`, `ValidationQuestion`, `PublicCodeCheckSpec`, `AssertBlock`, branches.
- **JSON spec:** `<script id="tutorial-data">` in [`hugo/layouts/tutorials/single.html`](../../../hugo/layouts/tutorials/single.html).
- **Renderer:** ~48 Vue islands. Tutorial-page ones: `validation`, `code-check`, `tutorial-branches`, `puzzle`, PiP, rating, feedback. Each hydrates a fixed CSS-selector mount div.
- **AI-authored content already ships:** [`srv/lib/ai-quiz-generator.js`](../../../srv/lib/ai-quiz-generator.js) (forced-tool-call LLM, `QUIZ_OUTPUT_SCHEMA`, `[AUTOAUTHOR_*]` directives), [`srv/lib/code-check-llm.js`](../../../srv/lib/code-check-llm.js), AI free-text grading.
- **Anti-leak contract (load-bearing):** reference answers/solutions are stripped from public frontmatter and `tutorial-data`, kept server-only in HANA (`ValidateAnswerSpecs`). Any generative-UI work must preserve this.

**Gaps vs. json-render:** (1) today's JSON is *content data*, not a *UI layout spec*; (2) the JSON→component map is hardcoded per-island by mount-point CSS selector, not a generic dispatcher; (3) AI authors *content* (quiz questions), never *layout*.

### The MCP surface has the exact seam MCP Apps extends

Built on `@cap-js/mcp@1.3.0` + the reference `@modelcontextprotocol/sdk` (transitive). Five CDS services expose MCP: `/mcp/search`, `/mcp/homepage`, `/mcp/graph`, `/mcp/api`, `/mcp/admin`. Core plumbing in [`srv/lib/mcp-compose-router.js`](../../../srv/lib/mcp-compose-router.js) (already calls `server.registerResource`) and [`srv/lib/mcp-resources.js`](../../../srv/lib/mcp-resources.js) (`tutorial://{slug}`, `mission://{slug}`, `concept://{id}` resource templates — all `application/json`). See [mcp-server.md](./mcp-server.md).

Tool output today is `{ content: [{ type: "text", text: <JSON> }] }` — plain text/JSON. **This is the exact seam MCP Apps extends:** add a `ui://` resource in `mcp-resources.js` and have a tool return a resource-link with `_meta.ui.resourceUri`. No sandbox/iframe infra exists yet; it would be net-new but small.

There is **zero** `ui://` / MCP-Apps / json-render / generative-UI surface anywhere today. Both are greenfield. Existing AI-driven UI (RPT-1 ValueList recs, Joule `/chat/stream`, recommendation rails, KG cluster Q&A, AI grading) flows through non-MCP channels. Closest json-render analog already in the tree: the KG `TypeConfigEntry` / `kg-resource-type-config.js` — the server ships a wire UI config the Vue client renders type-agnostically (confined to the KG sidebar).

---

## Candidate use cases (ranked)

**json-render — our own web UI**

1. **AI-generated practice/challenge widget per tutorial** *(best first spike — the POC below).* Extend the AI-quiz pipeline to emit a json-render *UI spec*, rendered by a small Vue catalog mapping to existing components. Reuses `ai-quiz-generator.js` and `types.ts`; respects the anti-leak contract.
2. **Adaptive "what next" panel.** AI composes a result card (tutorials, missions, KG prerequisites) as a json-render spec fed by existing `recommendations.js` + `kg_*` data — replacing bespoke `related-graph`/rails markup with a generic renderer.
3. **Generic island dispatcher.** Long-term consolidation of the ~48 mount-point islands toward one catalog + dispatcher. Do only if 1–2 prove the model.

**MCP Apps — into AI clients**

4. **Interactive tutorial-step / code-check app** returned by `get_tutorial_step` / `semantic_search` as a `ui://` resource — a dev in an MCP host gets the runnable step widget inline instead of text. Insertion point: `mcp-resources.js` + tool result shape in `mcp-compose-router.js`.
5. **KG explorer / learning-path builder** as an MCP App, mirroring `/explore`.

---

## Recommendation

Pursue **json-render as the lead bet** and **MCP Apps as a smaller, later, complementary bet** — both as time-boxed, feature-flagged spikes, neither committed to the roadmap yet.

- json-render fits the actual audience and rhymes with the existing island/`tutorial-data` architecture.
- MCP Apps is cheap to prototype on the mature MCP surface but reaches fewer users and depends on host adoption of a young spec.
- Both are additive behind feature flags (`MCP_*` / `KG_*` DB-backed, fail-open — house style). The current island pipeline stays.

The POC in this spike proves use case #1. MCP Apps is documented here as the next spike; no MCP-Apps code ships in this pass.

---

## POC (this spike) — use case #1

A minimal, fully-tested proof of the json-render model — **no build-pipeline or deploy changes**, verifiable with `npm test`:

| File | Role (json-render layer) |
| --- | --- |
| [`srv/lib/ai-challenge-spec.js`](../../../srv/lib/ai-challenge-spec.js) | The AI authors a **UI spec** — a typed node tree from a fixed `CATALOG` — via a forced tool call (reuses the `callModel` dep pattern from `ai-quiz-generator.js`). Enforces the catalog, cross-field validity, and the **anti-leak contract**: free-text reference answers are stripped from the public spec and returned separately for the `ValidateAnswerSpecs` sidecar. |
| [`hugo-apps/src/challenge-render/ChallengeRenderer.vue`](../../../hugo-apps/src/challenge-render/ChallengeRenderer.vue) | The **renderer** — maps each node `type` to a component via a catalog registry. Unknown types are dropped, never executed (the json-render safety guarantee). |
| [`test/lib/ai-challenge-spec.test.js`](../../../test/lib/ai-challenge-spec.test.js), [`hugo-apps/src/challenge-render/ChallengeRenderer.test.ts`](../../../hugo-apps/src/challenge-render/ChallengeRenderer.test.ts) | Prove generation, catalog enforcement, anti-leak, and render. |
| `CHALLENGE_WIDGET_ENABLED` in [`srv/lib/feature-flags/registry.js`](../../../srv/lib/feature-flags/registry.js) | DB flag (`flag.challengeWidget`), default OFF, DEV-only, fail-open — the widget ships dark until greenlit. |

What this deliberately does **not** do (out of spike scope): wire a Vite entry / island manifest / Hugo shortcode mount, call a live model, or touch the production quiz path. Promoting the widget to a rendered island is the follow-on if the model is greenlit.

**Verify:** `npx vitest run --project unit test/lib/ai-challenge-spec.test.js hugo-apps/src/challenge-render/ChallengeRenderer.test.ts` (18 assertions incl. anti-leak). Full render on a page would additionally need `npm run fetch-tutorials` + `npm run dev` after the island is wired.

---

## Next steps

1. Review this doc + POC PR (targets DEV).
2. If json-render is greenlit past the POC: scope use case #2, and evaluate a generic island dispatcher (#3).
3. Separate spike for MCP Apps use case #4 on the existing `/mcp/search` surface.
