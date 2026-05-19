const PERSONA = `You are Joule, an AI assistant embedded in the SAP Tutorial Platform. You ONLY answer questions about SAP tutorials and directly related topics (SAP technologies, the tutorial content, how to complete a step). If asked about anything else, politely redirect: "I can only help with SAP tutorials. Want me to find one about <topic>?". Never invent tutorial slugs, step numbers, or URLs. If you don't know, call the searchTutorials tool or say so.`;

const ADMIN_PERSONA = `You are Joule, an AI assistant embedded in the SAP
Tutorial Platform Admin Console. Your audience is tutorial AUTHORS and
PLATFORM ADMINS — people who build, publish, and operate the tutorial system
itself, not learners.

For "how does X work" questions about THIS system, call \`searchAdminDocs\`
first to ground your answer in the repository documentation. Cite the doc
path. If \`searchAdminDocs\` returns nothing relevant, say you don't have a
documented answer rather than inventing behavior or file paths.

For catalog questions (find a tutorial / mission / group), use
\`searchTutorials\`.

For analytical questions about tutorial usage, call \`analyticsQuery\` with a
structured plan. Allowed facts: completion, start. Allowed dimensions:
taskType, event, tag, mission, tutorial, group, completionMonth,
completionWeek. Allowed measures: count, distinctUsers. Date filters use
\`sinceDays\` or \`between\`. The system enforces k-anonymity (cells with
fewer than 5 distinct users are suppressed) and never exposes user identity.
If a question cannot be expressed within this schema, say so plainly rather
than guessing.

Never include credentials, API keys, or production URLs in responses.`;

const STEP_TEXT_BUDGET = 4000;

function tutorialLayer(ctx) {
  const lines = [ctx.title ? `Current page: tutorial "${ctx.title}".` : 'Current page: a tutorial.'];
  if (ctx.description) lines.push(`Description: ${ctx.description}`);
  if (Array.isArray(ctx.tags) && ctx.tags.length) lines.push(`Tags: ${ctx.tags.join(', ')}`);
  if (ctx.stepCount) lines.push(`Total steps: ${ctx.stepCount}.`);
  if (ctx.currentStep) lines.push(`User is currently on step ${ctx.currentStep}.`);
  if (Array.isArray(ctx.expandedSteps) && ctx.expandedSteps.length) {
    lines.push(`Currently expanded: ${ctx.expandedSteps.join('; ')}`);
  }
  if (typeof ctx.currentStepText === 'string' && ctx.currentStepText.trim()) {
    const excerpt = ctx.currentStepText.slice(0, STEP_TEXT_BUDGET);
    lines.push(`Visible step content (verbatim, may be truncated):\n"""\n${excerpt}\n"""`);
    lines.push('When the question is about the step the user is reading, answer from the verbatim content above. Cite the step number.');
  }
  lines.push('Prefer answering about THIS tutorial; cite step numbers. Only call searchTutorials if the user asks about a different tutorial.');
  return lines.join('\n');
}

function searchLayer(ctx) {
  const lines = ['Current page: tutorial search.'];
  if (ctx.query) lines.push(`Active query: "${ctx.query}"`);
  if (Array.isArray(ctx.filters) && ctx.filters.length) lines.push(`Active filters: ${ctx.filters.join(', ')}`);
  lines.push('Always call searchTutorials first; summarize 1–3 best matches with slug + a one-line reason.');
  return lines.join('\n');
}

function collectionLayer(ctx, kindLabel) {
  const lines = [ctx.title ? `Current page: ${kindLabel} "${ctx.title}".` : `Current page: a ${kindLabel}.`];
  if (Array.isArray(ctx.tutorials)) {
    const named = ctx.tutorials.filter((t) => t?.title);
    if (named.length) {
      const list = named.map((t, i) => `${i + 1}. ${t.title}`).join('\n');
      lines.push(`Contained tutorials:\n${list}`);
    }
  }
  lines.push(`Explain the path, prerequisites, and suggest the next logical tutorial.`);
  return lines.join('\n');
}

function adminLayer(ctx) {
  const lines = [];
  if (ctx.tool) {
    const title = ctx.toolTitle || ctx.tool;
    lines.push(`Current admin tool: "${title}" (route key: ${ctx.tool}).`);
  } else {
    lines.push('Current admin tool: dashboard (no specific tool selected).');
  }
  if (ctx.entity?.id) {
    const e = ctx.entity;
    lines.push(`Currently selected ${e.type || 'entity'}: ${JSON.stringify({ id: e.id, title: e.title, slug: e.slug }).slice(0, 240)}.`);
  }
  lines.push('You may call searchAdminDocs, searchTutorials, or analyticsQuery. Never expose user identity, email, or request IP.');
  return lines.join('\n');
}

function pageLayer(pageContext) {
  switch (pageContext?.kind) {
    case 'tutorial': return tutorialLayer(pageContext);
    case 'search':   return searchLayer(pageContext);
    case 'mission':  return collectionLayer(pageContext, 'mission');
    case 'group':    return collectionLayer(pageContext, 'group');
    case 'admin':    return adminLayer(pageContext);
    default:         return 'Use searchTutorials liberally to ground answers.';
  }
}

function userLayer(user) {
  if (!user || !user.firstName) return '';
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ');
  return `The user's name is ${name}. Use it sparingly.`;
}

export function buildSystemPrompt(pageContext, user) {
  const persona = pageContext?.kind === 'admin' ? ADMIN_PERSONA : PERSONA;
  return [persona, pageLayer(pageContext), userLayer(user)].filter(Boolean).join('\n\n');
}
