# Free-text Grader

The free-text grader is an AI-backed extension of the
[validation widget](./validation-widget.md). When an author marks a
`[VALIDATE_N]` text question with `###Grading: ai-judged` (or uses the
`regex` rule type, which auto-routes to AI grading), the answer is
graded server-side by an LLM with the correctAnswer kept off the wire.
Local-first questions (multiple-choice, plain text equality) keep
client-side grading and continue to ship `correctAnswer` in the
public page JSON.

This grader is the production hardening of the issue #205 code-check
spike — it reuses the same prompt-redaction layer, the same per-user
rate-limit pattern, and the same admin-driven feature flag wiring.

## End-to-end flow

```text
Author writes [VALIDATE_N] block in a -Contribution rules.vr
  → ###Grading: ai-judged directive (or rule type === 'regex')
    → scripts/parsers/rules.ts strips correctAnswer from public frontmatter
      → fetch-tutorials writes .tutorial-cache/<slug>.validate-answer.json sidecar
        → scripts/lib/publish-validate-answer.js POSTs sidecars to
          /content/validate-answer-specs (bearer-auth via CONTENT_API_KEY)
            → ValidateAnswerSpecs HANA entity (correctAnswer + question + slug + step + qi)

At runtime:
  Validation.vue (hugo-apps) sees the question marked aiJudged: true
    → POST /api/validate-answer { slug, stepNumber, qi, learnerAnswer }
      → /api/validate-answer Express handler (XSUAA, rate-limited)
        → dispatchValidateAnswer (srv/lib/validate-answer-tool.js)
          → defaultLoadQuestion — pulls correctAnswer from ValidateAnswerSpecs
            → defaultCallModel — forced tool call against the configured LLM
              → redactReferenceLeaks (reused from PR #205)
                → 3-state verdict: pass / partial / fail (+ optional model hint)
                  → telemetry row in ValidateAnswerSubmissions
                    → response back to Validation.vue
                      → step-validated CustomEvent + data-validated="true" gate
```

## Feature flag

`ChatSettings.validateAnswerEnabled` (boolean, default **false**).
The CAP `ChatSettings` singleton is admin-edited via the Joule Chat
Settings tile in `/admin-ui/`. Per-environment rollout is the
expected pattern: flip on in dev, then QA, then prod after smoke.

When the flag is `false`, `/api/validate-answer` returns **HTTP 503
with `{ error: 'disabled' }`**. The widget treats 503-disabled as a
fourth UI state — "Answer checking is temporarily unavailable" — and
specifically does **not** mark the question wrong, so a learner whose
admin has the flag off can still proceed (the Done-button gate falls
through to the live-submit path on the other questions in the step).

## Anti-leak guarantees

| Surface | Carries `correctAnswer`? | Notes |
| --- | --- | --- |
| `<script id="tutorial-data">` (public) | **No** for AI-graded questions | Parser strips before frontmatter emit |
| `<slug>.validate-answer.json` sidecar | Yes | Never copied into `approuter/static/`; consumed only by `publish-content.ts` |
| `ValidateAnswerSpecs` HANA table | Yes | Server-side only; XSUAA-protected publish endpoint |
| LLM prompt | Yes (the model needs it to grade) | `redactReferenceLeaks` (reused from PR #205) scrubs the model's *response* before it reaches the learner |
| `ValidateAnswerSubmissions` telemetry | Yes | Documented trade-off — captured for explainability and admin review; covered by `@PersonalData.cascade` so anonymization clears it |

The local-first path (multiple-choice + plain-text equality) is
unchanged and continues to ship `correctAnswer` in `<script
id="tutorial-data">` — see the
[validation widget anti-leak section](./validation-widget.md#anti-leak-documented-trade-off).

## Rate limits

Same shape as `/api/codecheck` (see
[testing-endpoints.md](../operations/testing-endpoints.md) for the
full endpoint table):

| Scope | Window | Cap | Returns on breach |
| --- | --- | --- | --- |
| Per user | 1 hour | 30 calls | HTTP 429 |
| Per (user, slug, step) | 5 minutes | 5 calls | HTTP 429 |

Both windows are sliding and tracked in process memory; restarts reset
both. This is intentional — the AI cost ceiling is a soft guardrail
around classroom abuse, not a hard quota.

## Local development

To exercise the AI path on a hybrid run:

```bash
# In a hybrid CAP shell
cds repl --bind capdb-dev
```

```js
// At the prompt
await UPDATE('com.sap.developers.ims.ChatSettings').set({ validateAnswerEnabled: true });
```

Or, equivalently, from a one-shot script:

```bash
npx cds bind --exec -- node -e "const cds = require('@sap/cds'); \
  cds.connect.to('db').then(db => db.run(UPDATE('com.sap.developers.ims.ChatSettings').set({ validateAnswerEnabled: true })));"
```

The flag is also editable via the Joule Chat Settings tile at
`/admin-ui/#joule-display`. To disable, set back to `false` — the
widget will display the 503-disabled UI state on next submit.

## Author flow

To opt a `[VALIDATE_N]` text question into AI grading, either:

1. **Explicit:** add a `###Grading: ai-judged` directive line in the
   block.
2. **Implicit (auto-route):** use a `regex` rule type — the parser
   recognizes that the question can't be exact-matched client-side
   and routes it to the AI path.

Multiple-choice questions can be marked `###Grading: ai-judged` and the
parser will accept the directive (setting `aiGrading: true` on the emitted
question), but routing them through the LLM grader is not recommended:
the prompt is structured for free-text answers and option-letter
submissions produce low-quality verdicts. Author guidance: only use
`###Grading: ai-judged` on text-typed questions. The runtime does not
enforce this — the safeguard is at authoring time.

See the [tutorial authoring guide](../../authors/writing-tutorials.md) for the
complete `[VALIDATE_N]` syntax. The author preview at `/tutorials-qa/`
is the recommended way to verify a new question type before
publishing — the QA srv has its own `validateAnswerEnabled` flag and
its own `ValidateAnswerSpecs` table.

## Reference

- Tool dispatcher: [`srv/lib/validate-answer-tool.js`](../../../srv/lib/validate-answer-tool.js)
- Express handler: [`srv/lib/validate-answer-handler.js`](../../../srv/lib/validate-answer-handler.js)
- Question loader: [`srv/lib/validate-answer-question-loader.js`](../../../srv/lib/validate-answer-question-loader.js)
- Spec publish endpoint: [`srv/lib/validate-answer-spec-publish.js`](../../../srv/lib/validate-answer-spec-publish.js)
- Prompt + tool schema: [`srv/lib/validate-answer-prompt.js`](../../../srv/lib/validate-answer-prompt.js)
- Publish-content extension: [`scripts/lib/publish-validate-answer.js`](../../../scripts/lib/publish-validate-answer.js)
- Validation island: [`hugo-apps/src/validation/Validation.vue`](../../../hugo-apps/src/validation/Validation.vue)
- Sibling docs:
  - [Validation widget](./validation-widget.md) (PR #226 — local-first widget this extends)
  - AI code-check spike: `docs/superpowers/specs/2026-06-02-ai-code-check-spike-design.md` (PR #205 — same prompt redaction + rate-limit pattern)
- Spec: `docs/superpowers/specs/2026-06-04-209-free-text-grader-design.md`
- Tracking: [sap-tutorials/tutorials-ims#209](https://github.com/sap-tutorials/tutorials-ims/issues/209)
