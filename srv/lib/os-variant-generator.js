// srv/lib/os-variant-generator.js
// AI Core call for the /author/generateOsVariants action (issue #173).
// Mirrors srv/lib/code-check-llm.js (settings resolution, OrchestrationClient
// construction); plain text response with a literal sentinel separator
// instead of forced tool-calls.

import cds from '@sap/cds';
import { randomUUID } from 'node:crypto';
import { OrchestrationClient } from '@sap-ai-sdk/orchestration';
import { persistAuthorAiRequest } from './author-ai-persist.js';

const LOG = cds.log('os-variants');
const SENTINEL = '===NEXT_VARIANT===';

const SYSTEM_PROMPT = `You rewrite tutorial instructions for SAP developers. Given source markdown
written for a specific operating system, produce equivalent instructions for the target OS.

Rules:
- Translate shell commands (PowerShell <-> bash, file paths, line continuations: backtick <-> backslash).
- Translate path conventions (C:\\Users\\... <-> ~/, / vs \\, drive letters).
- Translate package managers when an obvious equivalent exists (choco <-> brew <-> apt).
  When no equivalent exists, leave the instruction in prose form ("install <X> for your distro").
- BAS == Linux container with VS Code; treat it as Linux but call out terminal location
  ("In the BAS terminal, run...") when relevant.
- Preserve markdown structure exactly: same heading levels, same list shapes, same code-fence languages.
- Preserve all non-OS content verbatim (concepts, screenshots, links, prose explanations).
- Never invent commands you are uncertain about; if you cannot translate, leave a TODO marker
  in markdown comment form: <!-- TODO: confirm <command> on <os> -->.

Output: ONE markdown block per requested target OS, in the order requested. Each block separated
by the literal sentinel "${SENTINEL}" on its own line. No preamble, no explanation, no fences
around the whole.`;

function renderUserPrompt({ sourceMarkdown, sourceOS, targetOSes, context }) {
  const ctxParts = [];
  if (context?.tutorialSlug)        ctxParts.push(`Tutorial: ${context.tutorialSlug}`);
  if (context?.stepHeading)         ctxParts.push(`Step: ${context.stepHeading}`);
  if (context?.surroundingMarkdown) ctxParts.push(`Surrounding context:\n${context.surroundingMarkdown.slice(0, 2000)}`);
  const ctxBlock = ctxParts.length ? `\n\n${ctxParts.join('\n')}\n` : '';

  return `Source OS: ${sourceOS}
Target OSes (in order): ${targetOSes.join(', ')}
${ctxBlock}
--- BEGIN SOURCE MARKDOWN ---
${sourceMarkdown}
--- END SOURCE MARKDOWN ---

Produce ${targetOSes.length} block${targetOSes.length === 1 ? '' : 's'} separated by ${SENTINEL}.`;
}

/**
 * Resolve model + deployment from ChatSettings, falling back to env vars + defaults.
 * Mirrors srv/lib/code-check-llm.js settings resolution including the build-pipeline
 * raw-SQL fallback (see feedback_cds_entities_runtime_only in project memory).
 */
async function resolveSettings() {
  let settings = null;
  try {
    if (typeof cds.entities === 'function') {
      const { ChatSettings } = cds.entities('com.sap.developers.ims');
      settings = await SELECT.one.from(ChatSettings);
    } else {
      const db = await cds.connect.to('db');
      const rows = await db.run(
        'SELECT modelName, deploymentId FROM COM_SAP_DEVELOPERS_IMS_CHATSETTINGS LIMIT 1'
      );
      settings = rows?.[0] ?? null;
    }
  } catch (err) {
    LOG.warn('ChatSettings read failed; using env-var defaults', err.message);
  }
  const modelName = settings?.modelName
    || settings?.MODELNAME
    || process.env.CHAT_MODEL_NAME
    || 'anthropic--claude-4.6-sonnet';
  const deploymentId = settings?.deploymentId
    || settings?.DEPLOYMENTID
    || process.env.CHAT_DEPLOYMENT_ID
    || null;
  return { modelName, deploymentId };
}

export async function generateOsVariants({
  sourceMarkdown, sourceOS, targetOSes, context = {}, userId,
}) {
  const requestId = randomUUID();
  const startedAt = Date.now();
  // Captured before the AI call so failure-path persist still records the
  // resolved model (loses observability about which model was attempted otherwise).
  let resolvedModel = null;

  try {
    const { modelName, deploymentId } = await resolveSettings();
    resolvedModel = modelName;
    const client = new OrchestrationClient(
      {
        promptTemplating: {
          model: {
            name: modelName,
            params: { max_tokens: 2000, temperature: 0.2 },
          },
          prompt: {
            template: [{ role: 'system', content: SYSTEM_PROMPT }],
          },
        },
      },
      { deploymentId }
    );

    const userMessage = renderUserPrompt({ sourceMarkdown, sourceOS, targetOSes, context });
    const response = await client.chatCompletion({
      messagesHistory: [{ role: 'user', content: userMessage }],
    });

    const content = (typeof response.getContent === 'function') ? (response.getContent() ?? '') : '';
    const tokensUsed = response.getTokenUsage?.()?.total_tokens ?? null;

    const blocks = content.split(SENTINEL).map((s) => s.trim()).filter(Boolean);
    if (blocks.length !== targetOSes.length) {
      throw new Error(`AI returned ${blocks.length} blocks, expected ${targetOSes.length}`);
    }
    const variants = targetOSes.map((os, i) => ({ os, markdown: blocks[i] }));

    await persistAuthorAiRequest({
      requestId, userId, sourceOS, targetOSes, sourceMarkdown, variants,
      tokensUsed, model: modelName,
      durationMs: Date.now() - startedAt, errorCode: null,
    });

    return { variants, model: modelName, tokensUsed, requestId };
  } catch (err) {
    LOG.error(`generateOsVariants failed (${requestId})`, err);
    await persistAuthorAiRequest({
      requestId, userId, sourceOS, targetOSes, sourceMarkdown, variants: null,
      tokensUsed: null, model: resolvedModel,
      durationMs: Date.now() - startedAt,
      errorCode: err.code ?? err.message?.slice(0, 200) ?? 'unknown',
    });
    throw err;
  }
}
