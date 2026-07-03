// test/smoke/joule-search.smoke.test.js
//
// Post-deploy smoke test for the Joule search-expansion end-to-end chain
// (#943 Task 9). Exercises:
//   POST /chat/stream with a search-shaped prompt →
//   confirms the LLM picks expandSearchConcepts, the handler runs,
//   the SSE response mentions the tool call.
//
// Skips with a warning when SMOKE_BASE_URL/SMOKE_SRV_URL are missing.
// Skips with a warning when SMOKE_AUTH_TOKEN is missing.
//
// IMPORTANT: This smoke also requires `ChatSettings.kgSearchExpansionEnabled = true`
// on the target deployment (defaults ON in fresh deploys per Task 1 schema).
// If the flag is off, the tool is not registered in the LLM's tool list and
// the test will see no expandSearchConcepts tool-call frame. The assertion
// is permissive — the response body must include the string "expandSearchConcepts"
// (the SSE frame is `data: {"type":"tool","name":"expandSearchConcepts",…}`
// per srv/lib/chat-orchestrator.js:675).
//
// The Concept-embeddings backfill must also have been seeded on the target
// env (admin clicks "Seed Concept Embeddings Now" in /admin-ui/#chat-settings,
// or waits for the minute-17-hourly reconciliation cron). Until seeded the
// tool returns { concepts: [], tutorials: [] } — the tool-call frame still
// fires, so this smoke still passes.
//
// HOW TO RUN
//   SMOKE_BASE_URL='https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com' \
//   SMOKE_SRV_URL='https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com' \
//   SMOKE_AUTH_TOKEN="$(cf oauth-token | tr -d '\n')" \
//   npm run test:smoke -- test/smoke/joule-search.smoke.test.js
//
// Refs #943.

import { describe, it, expect } from 'vitest'
import { fetchWithRetry } from './smoke.config.js'

const APPROUTER = process.env.SMOKE_BASE_URL
const SRV = process.env.SMOKE_SRV_URL
const AUTH_TOKEN = process.env.SMOKE_AUTH_TOKEN

describe.runIf(APPROUTER && SRV)('Joule expandSearchConcepts smoke (issue #943)', () => {
  it.runIf(AUTH_TOKEN)('POST /chat/stream with a search prompt emits an expandSearchConcepts tool call', async () => {
    // Search-shaped prompt matches what the navigator Joule button sends
    // (see hugo-apps/src/navigator/TutorialNavigator.vue handleJouleClick).
    const res = await fetchWithRetry(`${SRV}/chat/stream`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        messages: [
          {
            role: 'user',
            content:
              'Find tutorials about: abap async\n\nUse the expandSearchConcepts tool for related concepts, then searchTutorials for keyword matches. Summarise the top results with why they\'re relevant.',
          },
        ],
        pageContext: { kind: 'generic' },
      }),
    })

    expect(res.status).toBe(200)

    // Accumulate the SSE body. The orchestrator emits
    // `data: {"type":"tool","name":"expandSearchConcepts","args":{…}}`
    // when the LLM picks the tool (srv/lib/chat-orchestrator.js:675).
    const body = await res.text()
    expect(body.length).toBeGreaterThan(0)
    expect(body).toContain('expandSearchConcepts')
  }, 60_000) // 60s — chat tool dispatches + LLM streaming can be slow
})
