// srv/lib/a2a/skills.js
// A2A skill registry (#1220). The ONLY module that knows how A2A skills map to
// internal capabilities. Chat skill → streamChat (full agentic loop). Tool
// skills → dispatchTool (the same handlers the chat LLM calls).
import cds from '@sap/cds';
import { dispatchTool, streamChat } from '../chat-orchestrator.js';
import { buildChatInvocation } from '../chat-invocation.js';
import { a2aMessageToInternal, makeSseShim } from './message-adapter.js';
import { putTask } from './task-store.js';

const LOG = cds.log('a2a');

export class A2aError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// skillId → { tool, arg? }. `arg` names the single string param the tool takes;
// omitted → no positional arg (tool reads from user context).
export const SKILL_TOOL_MAP = {
  'search-tutorials': { tool: 'searchTutorials', arg: 'query' },
  'user-progress':    { tool: 'getUserProgress' },
  'knowledge-graph':  { tool: 'expandSearchConcepts', arg: 'query' },
  'tutorial-steps':   { tool: 'getRelevantSteps', arg: 'question' },
};

export function resolveSkillId(message, params) {
  return params?.metadata?.skillId || message?.metadata?.skillId || 'tutorial-chat';
}

// FIX 8: prototype-pollution guard — Object.hasOwn prevents __proto__/constructor
// from resolving as a valid skill.
export async function runToolSkill({ skillId, text, user }) {
  if (!Object.hasOwn(SKILL_TOOL_MAP, skillId)) throw new A2aError(-32602, `Unknown skillId '${skillId}'`);
  const spec = SKILL_TOOL_MAP[skillId];
  const args = spec.arg ? { [spec.arg]: text } : {};
  return dispatchTool(spec.tool, args, user);
}

export async function runChatSkillStream({ message, user, res, taskId, contextId, settings, isAdmin }) {
  const { messages, pageContext } = a2aMessageToInternal(message);
  // FIX 5: buildChatInvocation runs BEFORE SSE headers are sent so that a
  // throw here (pre-flight failure) allows the router's outer catch to emit a
  // proper -32603 JSON-RPC error instead of sending an empty stream.
  const { system, tools } = await buildChatInvocation({ pageContext, user, settings, isAdmin });

  // FIX 5: SSE headers are set AFTER the pre-flight succeeds so early-exit
  // errors in buildChatInvocation do not produce a committed SSE response.
  res.setHeader?.('Content-Type', 'text/event-stream');
  res.setHeader?.('Cache-Control', 'no-cache, no-transform');
  res.setHeader?.('Connection', 'keep-alive');
  res.setHeader?.('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  // FIX 4 (IDOR): include userId in EVERY putTask snapshot so ownership checks work.
  // FIX 3: track error frames via onFrame hook to distinguish streamChat success
  // from an internal error that streamChat swallowed (returning normally after
  // emitting a {type:'error'} frame — meaning the try/catch below never fires).
  let sawError = false;
  const shim = makeSseShim(res, { taskId, contextId, onFrame: (f) => { if (f && f.type === 'error') sawError = true; } });
  await putTask(taskId, { id: taskId, contextId, userId: user?.id, state: 'working' });
  const abort = new AbortController();
  res.on?.('close', () => abort.abort());
  try {
    await streamChat({
      res: shim, system, messages,
      deploymentId: settings.deploymentId, modelName: settings.modelName,
      temperature: settings.temperature, maxTokens: settings.maxTokens,
      signal: abort.signal, tools, user, pageContext,
    });
    // FIX 3: use sawError to set correct terminal state.
    await putTask(taskId, { id: taskId, contextId, userId: user?.id, state: sawError ? 'failed' : 'completed' });
  } catch (e) {
    // Isolate the failed-state write so a task-store reject cannot mask the
    // original streamChat error the caller needs to see.
    try {
      await putTask(taskId, { id: taskId, contextId, userId: user?.id, state: 'failed', error: e.message });
    } catch (storeErr) {
      LOG.warn(`putTask(failed) for ${taskId} threw — ${storeErr.message}`);
    }
    throw e;
  }
}
