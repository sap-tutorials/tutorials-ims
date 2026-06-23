// test/hybrid/joule-tool-pick-find-path.test.js
// AI-judge fixture for the findLearningPath Joule tool's LLM tool-pick
// behavior (issue #445 Phase 2). Regression-guard against tool description
// changes breaking the LLM's discrimination between findLearningPath /
// getRelevantSteps / checkCode.
//
// GATED by HYBRID_AI_TESTS=true. Cost: ~$0.12 per opt-in run on default model.
// Default test:hybrid runs at $0.
//
// HOW TO RUN
//   HYBRID_AI_TESTS=true ALLOW_HYBRID_WRITES=true npx cds bind --exec -- \
//     npx vitest run --project hybrid test/hybrid/joule-tool-pick-find-path.test.js

import { describe, it, expect } from 'vitest'
import cds from '@sap/cds'
import { isSafeForWrites } from './_guard.js'
import { OrchestrationClient } from '@sap-ai-sdk/orchestration'
import {
  SEARCH_TUTORIALS_TOOL,
  GET_RELEVANT_STEPS_TOOL,
  GET_USER_PROGRESS_TOOL,
  CHECK_CODE_TOOL,
  FIND_LEARNING_PATH_TOOL,
} from '../../srv/lib/chat-orchestrator.js'

/** Resolve modelName + deploymentId tolerantly — same fallback chain as
 *  category-classifier-llm.js. Does NOT throw on null deploymentId so the
 *  SAP AI SDK can auto-discover the deployment from the aicore binding. */
async function resolveSettings() {
  let settings = null
  try {
    if (typeof cds.entities === 'function') {
      const { ChatSettings } = cds.entities('com.sap.developers.ims')
      settings = await SELECT.one.from(ChatSettings)
    } else {
      const db = await cds.connect.to('db')
      const rows = await db.run(
        'SELECT modelName, deploymentId FROM COM_SAP_DEVELOPERS_IMS_CHATSETTINGS LIMIT 1'
      )
      settings = rows?.[0] ?? null
    }
  } catch {
    // fall through to env-var defaults
  }
  const modelName =
    settings?.modelName ||
    settings?.MODELNAME ||
    process.env.CHAT_MODEL_NAME ||
    'anthropic--claude-4.6-sonnet'
  const deploymentId =
    settings?.deploymentId ||
    settings?.DEPLOYMENTID ||
    process.env.CHAT_DEPLOYMENT_ID ||
    null
  return { modelName, deploymentId }
}

const RUN = process.env.HYBRID_AI_TESTS === 'true' && isSafeForWrites()

cds.test('serve', '--project', '.', '--profile', 'hybrid')

const SYSTEM_PROMPT =
  'You are Joule, the SAP Developers assistant. Use the available tools when appropriate to answer the user accurately.'

const TOOLS = [
  SEARCH_TUTORIALS_TOOL,
  GET_RELEVANT_STEPS_TOOL,
  GET_USER_PROGRESS_TOOL,
  CHECK_CODE_TOOL,
  FIND_LEARNING_PATH_TOOL,
]

const FIXTURES = [
  // EXPECT: findLearningPath (5)
  { prompt: 'I want to build my first CAP service that uses HANA Cloud', expected: 'findLearningPath' },
  { prompt: 'What should I learn after the CAP getting-started mission?', expected: 'findLearningPath' },
  { prompt: 'Show me a path from cap-handlers to hana-cloud-deployment', expected: 'findLearningPath' },
  { prompt: 'I want to learn how to deploy CAP apps to BTP', expected: 'findLearningPath' },
  { prompt: 'How do I get from where I am now to building Fiori apps?', expected: 'findLearningPath' },

  // EXPECT: getRelevantSteps (3)
  { prompt: 'How do I configure the dev space in this tutorial?', expected: 'getRelevantSteps' },
  { prompt: 'What does step 3 mean by "Cloud Foundry target"?', expected: 'getRelevantSteps' },
  { prompt: 'I am stuck on the npm install step', expected: 'getRelevantSteps' },

  // EXPECT: checkCode (2)
  { prompt: 'Can you review this code I wrote?\n```js\nconst x = 1\n```', expected: 'checkCode' },
  { prompt: 'Is this CAP service handler correct?\n```js\nthis.on("READ", ...)\n```', expected: 'checkCode' },

  // EXPECT: no tool call (2)
  { prompt: 'Hi Joule', expected: null },
  { prompt: 'Thanks!', expected: null },
]

const PASS_THRESHOLD = 11 // >=90% of 12

;(RUN ? describe : describe.skip)('AI-judge: findLearningPath tool-pick (issue #445)', () => {
  it(`picks the correct tool for >=${PASS_THRESHOLD}/12 fixture prompts`, async () => {
    const { modelName, deploymentId } = await resolveSettings()
    if (!deploymentId) {
      console.warn(
        '[AI-judge] No deploymentId available (ChatSettings.deploymentId is null and ' +
        'CHAT_DEPLOYMENT_ID env var not set). Skipping LLM calls. ' +
        'Set CHAT_DEPLOYMENT_ID to run this fixture against SAP AI Core.'
      )
      return
    }

    const client = new OrchestrationClient(
      {
        promptTemplating: {
          model: {
            name: modelName,
            params: { max_tokens: 200, temperature: 0 },
          },
          prompt: {
            template: [{ role: 'system', content: SYSTEM_PROMPT }],
            tools: TOOLS,
          },
        },
      },
      { deploymentId }
    )

    const results = []
    for (const fixture of FIXTURES) {
      const start = Date.now()
      try {
        const resp = await client.chatCompletion({
          messagesHistory: [{ role: 'user', content: fixture.prompt }],
        })
        const toolCalls = resp.getToolCalls?.() || []
        const firstToolName = toolCalls[0]?.function?.name || null
        const passed = firstToolName === fixture.expected
        results.push({
          prompt: fixture.prompt.slice(0, 60),
          expected: fixture.expected,
          got: firstToolName,
          passed,
          latencyMs: Date.now() - start,
        })
      } catch (err) {
        results.push({
          prompt: fixture.prompt.slice(0, 60),
          expected: fixture.expected,
          got: '<error>',
          passed: false,
          error: err.message?.slice(0, 200),
          latencyMs: Date.now() - start,
        })
      }
    }

    const passCount = results.filter(r => r.passed).length
    // Always log results so CI artifact shows per-fixture details
    console.log(`\n[AI-judge] ${passCount}/${FIXTURES.length} passed (threshold: ${PASS_THRESHOLD})`)
    for (const r of results) {
      const mark = r.passed ? 'PASS' : 'FAIL'
      const errSuffix = r.error ? ` ERR: ${r.error}` : ''
      console.log(
        `  ${mark} expected=${r.expected ?? 'null'} got=${r.got ?? 'null'} (${r.latencyMs}ms) "${r.prompt}"${errSuffix}`
      )
    }
    expect(passCount).toBeGreaterThanOrEqual(PASS_THRESHOLD)
  }, 240_000) // 12 prompts x ~10s each, with headroom
})
