// test/smoke/joule-search.smoke.test.js
//
// Post-deploy smoke test for the Joule search-expansion end-to-end chain
// (#943 Task 9). Sends a canned search-shaped prompt to the deployed
// /chat/stream endpoint and asserts the SSE response mentions the
// `expandSearchConcepts` tool call.
//
// The chat orchestrator emits SSE frames of the shape
//   data: {"type":"tool","name":"expandSearchConcepts","args":{...}}
// when the LLM picks the tool. A substring match on "expandSearchConcepts"
// in the streamed body catches that frame (see srv/lib/chat-orchestrator.js
// around the sse(res, { type: 'tool', ... }) call).
//
// Skips cleanly when SMOKE_SRV_URL is not set. Requires ChatSettings.
// kgSearchExpansionEnabled = true and the Concept-embeddings backfill to
// have been seeded on the target env (see Task 10 checklist).
//
// HOW TO RUN
//   SMOKE_SRV_URL=https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com \
//   SMOKE_BEARER=<dev-bearer> \
//   npx vitest run --project smoke test/smoke/joule-search.smoke.test.js
//
// Refs #943.

import { describe, it, expect } from 'vitest'

const SRV = process.env.SMOKE_SRV_URL
const describeMaybe = SRV ? describe : describe.skip

describeMaybe('post-deploy Joule search expansion smoke', () => {
  it('/chat/stream emits an expandSearchConcepts tool_use for a search prompt', async () => {
    const res = await fetch(`${SRV}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.SMOKE_BEARER ?? ''}` },
      body: JSON.stringify({ text: 'find tutorials about abap async' }),
    })
    expect(res.ok).toBe(true)
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let saw = false
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      const chunk = dec.decode(value)
      if (chunk.includes('expandSearchConcepts')) { saw = true; break }
    }
    expect(saw).toBe(true)
  }, 60_000)
})
