// srv/lib/chat-invocation.js
// Shared chat-setup used by BOTH the /chat/stream Express route (srv/server.js)
// and the A2A chat skill (srv/lib/a2a/skills.js). Extracted verbatim from the
// businessHandler so the two entrypoints cannot drift (#1220). Pure aside from
// the two awaited helpers it delegates to; does no DB read of its own — the
// caller passes `settings` (already read fresh) in.
import { toolsForContext } from './chat-orchestrator.js';
import { buildSystemPrompt } from './chat-context.js';

/**
 * @param {{pageContext:object, user:object, settings:object, isAdmin:boolean}} p
 * @returns {Promise<{system:string, tools:Array, effectivePageContext:object}>}
 */
export async function buildChatInvocation({ pageContext = { kind: 'generic' }, user, settings, isAdmin = false }) {
  const effectivePageContext = { ...pageContext };
  if (effectivePageContext.kind === 'admin' && !isAdmin) {
    effectivePageContext.kind = 'generic'; // forged context — degrade gracefully
  }
  const tools = await toolsForContext({ pageContext: effectivePageContext, isAdmin });
  const system = await buildSystemPrompt(effectivePageContext, {
    firstName: user?.attr?.given_name || user?.attr?.givenName || '',
    lastName:  user?.attr?.family_name || user?.attr?.familyName || ''
  }, settings);
  return { system, tools, effectivePageContext };
}
