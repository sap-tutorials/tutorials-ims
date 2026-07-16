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

export async function runToolSkill({ skillId, text, user }) {
  const spec = SKILL_TOOL_MAP[skillId];
  if (!spec) throw new A2aError(-32602, `Unknown skillId '${skillId}'`);
  const args = spec.arg ? { [spec.arg]: text } : {};
  return dispatchTool(spec.tool, args, user);
}

export async function runChatSkillStream({ message, user, res, taskId, contextId, settings, isAdmin }) {
  const { messages, pageContext } = a2aMessageToInternal(message);
  const { system, tools } = await buildChatInvocation({ pageContext, user, settings, isAdmin });
  await putTask(taskId, { id: taskId, contextId, state: 'working' });
  const shim = makeSseShim(res, { taskId, contextId });
  const abort = new AbortController();
  res.on?.('close', () => abort.abort());
  try {
    await streamChat({
      res: shim, system, messages,
      deploymentId: settings.deploymentId, modelName: settings.modelName,
      temperature: settings.temperature, maxTokens: settings.maxTokens,
      signal: abort.signal, tools, user, pageContext,
    });
    await putTask(taskId, { id: taskId, contextId, state: 'completed' });
  } catch (e) {
    // Isolate the failed-state write so a task-store reject cannot mask the
    // original streamChat error the caller needs to see.
    try {
      await putTask(taskId, { id: taskId, contextId, state: 'failed', error: e.message });
    } catch (storeErr) {
      LOG.warn(`putTask(failed) for ${taskId} threw — ${storeErr.message}`);
    }
    throw e;
  }
}
