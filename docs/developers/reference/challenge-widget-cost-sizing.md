# Challenge-Widget Flag-On PROD Generation — AI Core Cost Sizing (#2441 gate 3)

**Status: analytical estimate.** A live per-call measurement on DEV was deferred
(cf was targeted at PROD during a concurrent operation and could not be
repointed). Numbers below are derived from the challenge generator's known
prompt/schema sizes and the AI-quiz path's per-call profile (same model, same
forced-tool-call shape). **Confirm with a per-call measurement on DEV before any
bulk PROD rebuild** — see "How to get the live number" at the end.

## Model & call shape

- One model call per **substantive** step (`isStepSubstantive`,
  `scripts/lib/expand-ai-authored.ts` — ≥ MIN_SUBSTANTIVE_WORDS).
- Forced single tool call `submitChallenge` constrained to
  `CHALLENGE_OUTPUT_SCHEMA` (`srv/lib/ai-challenge-spec.js`), non-streaming.
- Model: the resolved chat LLM (`anthropic--claude-4.6-sonnet` default via
  `resolveChatLlmSettings`), same deployment the AI-quiz grader uses.

## Per-call token profile (measured statically + estimated)

| Component | Tokens (≈) | Basis |
|---|---|---|
| System prompt | 236 | `buildSystemPrompt().length / 4` (944 chars, measured) |
| Output schema (tool params) | 255 | `CHALLENGE_OUTPUT_SCHEMA` (1019 chars, measured) |
| Step body (user msg) | 400–1000 | typical substantive step 300–800 words |
| **Input subtotal** | **~900–1500** | sum of above |
| Completion (spec of 2–4 nodes) | 300–500 | estimated from schema shape |

**Per-call working figure: ~1,200 input + ~400 output ≈ 1,600 tokens.**

## Corpus denominators

- Tutorials: **~1,400** (issue figure).
- Substantive steps per tutorial: assume **~5** (conservative mid-estimate;
  refine from the live corpus count — see below).
- Substantive steps across the corpus: **~7,000**.

## Full cold flag-on pass (no cache — gate 2 not yet warm)

- Calls: **~7,000** (one per substantive step), **bounded by
  `AI_AUTHOR_BUILD_CAP`** (default 200 → a single build caps at 200 calls; a
  full pass therefore needs the cap raised or multiple capped runs).
- Tokens: 7,000 × ~1,600 ≈ **~11.2M tokens** (~8.4M in / ~2.8M out).

## Cached rebuild (gate 2 warm — the steady state)

- After the first cold pass populates `<slug>.challenge-spec-cache.json`, a
  rebuild with unchanged step bodies is a **100% cache hit → ~0 model calls**
  (`hashKey` over stepBody + PROMPT_VERSION + modelName).
- Only **changed/new steps** regenerate. At a plausible ~2% step churn per
  rebuild: ~140 calls ≈ **~224K tokens/rebuild** — a ~50× reduction vs cold.
- This is the entire point of doing gate 2 before this sizing: repeat PROD
  rebuilds cost cache-miss-only, not cold.

## Cost (fill in the deployment's per-token rate)

At an assumed blended $X per 1K tokens (substitute the AICore deployment's
Sonnet rate):
- Cold full pass: 11.2M tokens → **11,200 × $X**.
- Warm rebuild (2% churn): 224K tokens → **224 × $X**.

## How to get the live number (do this on DEV before bulk PROD)

1. `cf target -s dev`; pause the sap-devs scheduler.
2. `cds bind` AI Core (AICore-btp), `CHALLENGE_WIDGET_ENABLED=true`.
3. Cold pass on ~5–10 fetched slugs with a low `AI_AUTHOR_BUILD_CAP` (e.g. 30):
   the generator returns real `promptTokens`/`completionTokens`/`latencyMs` per
   call — average them to replace the ~1,600 working figure.
4. Warm pass (re-run): confirm ~0 model calls + log the `[challenge] … spec
   cache hit(s)` line to verify the gate-2 hit path.
5. Count substantive steps across the real corpus to replace the ~5/tutorial
   assumption, then re-multiply.
