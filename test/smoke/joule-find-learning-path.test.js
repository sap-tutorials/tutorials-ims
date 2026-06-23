// test/smoke/joule-find-learning-path.test.js
//
// HTTP smoke test for the Joule findLearningPath end-to-end chain (#445
// Phase 2). Exercises:
//   POST /chat/stream with a known findLearningPath-shaped prompt →
//   confirms the LLM picks findLearningPath, the handler runs,
//   PATH_BETWEEN procedure fires, the rendered list comes back.
//
// Skips with a warning when SMOKE_BASE_URL/SMOKE_SRV_URL are missing.
// Skips with a warning when SMOKE_AUTH_TOKEN is missing.
//
// IMPORTANT: This smoke also requires `ChatSettings.kgPathBetweenEnabled = true`
// on the target deployment. If the flag is off, the tool is not registered
// in the LLM's tool list and the test will see no findLearningPath tool-call
// in the response stream. The assertion is permissive — it only asserts the
// HTTP request itself succeeds + the streaming response contains tutorial
// references. The full LLM tool-pick discrimination is covered by the
// gated AI-judge fixture at test/hybrid/joule-tool-pick-find-path.test.js.
//
// HOW TO RUN
//   SMOKE_BASE_URL='https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com' \
//   SMOKE_SRV_URL='https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com' \
//   SMOKE_AUTH_TOKEN="$(cf oauth-token | tr -d '\n')" \
//   npm run test:smoke -- test/smoke/joule-find-learning-path.test.js
//
// Refs #445.

import { describe, it, expect } from 'vitest'
import { SRV_URL, fetchWithRetry } from './smoke.config.js'

const APPROUTER = process.env.SMOKE_BASE_URL
const SRV = process.env.SMOKE_SRV_URL
const AUTH_TOKEN = process.env.SMOKE_AUTH_TOKEN

describe.runIf(APPROUTER && SRV)('Joule findLearningPath smoke (issue #445)', () => {
  it.runIf(AUTH_TOKEN)('POST /chat/stream with a learning-path prompt produces a response', async () => {
    // The streaming endpoint returns SSE-formatted chunks. We don't need
    // to parse the stream incrementally — accumulating the body and
    // checking the final content is sufficient for a smoke check.
    const res = await fetchWithRetry(`${SRV}/chat/stream`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        messages: [
          { role: 'user', content: 'I want to learn how to deploy CAP apps to BTP' },
        ],
        // Use whatever model + deploymentId the server has configured;
        // smoke doesn't pin a specific model.
      }),
    })

    // 200 = streaming endpoint accepted the request and started the LLM call.
    // If the deployed srv hasn't picked up the kgPathBetweenEnabled flag flip,
    // the tool isn't registered — that still returns 200 with a text answer.
    expect(res.status).toBe(200)

    // Accumulate the SSE body. The streaming endpoint uses Server-Sent Events;
    // the body will contain `data:` lines with token deltas + a final marker.
    const body = await res.text()
    expect(body.length).toBeGreaterThan(0)

    // Loose assertion: the response should reference at least one tutorial
    // slug (either via the rendered learning-path list or an inline text
    // answer pointing at a slug). The slug shape is `[a-z0-9-]{3,80}` and
    // should appear at least once in the response body when the model
    // answers a learning-path question.
    //
    // We use a permissive regex because the response format depends on
    // whether kgPathBetweenEnabled is on (numbered list) or off (LLM
    // freeform answer). Both shapes contain at least one tutorial-slug-
    // shaped token.
    const slugReferenceCount = (body.match(/[a-z0-9]+(?:-[a-z0-9]+){2,}/g) || []).length
    expect(slugReferenceCount).toBeGreaterThan(0)
  }, 60_000) // 60s — chat tool dispatches + LLM streaming can be slow
})
