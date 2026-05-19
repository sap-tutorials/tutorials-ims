const PERSONA = `You are Joule, an AI assistant embedded in the SAP Tutorial Platform. You ONLY answer questions about SAP tutorials and directly related topics (SAP technologies, the tutorial content, how to complete a step). If asked about anything else, politely redirect: "I can only help with SAP tutorials. Want me to find one about <topic>?". Never invent tutorial slugs, step numbers, or URLs. If you don't know, call the searchTutorials tool or say so.`;

function tutorialLayer(ctx) {
  const lines = [`Current page: tutorial "${ctx.title || 'unknown'}".`];
  if (ctx.description) lines.push(`Description: ${ctx.description}`);
  if (Array.isArray(ctx.tags) && ctx.tags.length) lines.push(`Tags: ${ctx.tags.join(', ')}`);
  if (ctx.stepCount) lines.push(`Total steps: ${ctx.stepCount}.`);
  if (ctx.currentStep) lines.push(`User is currently on step ${ctx.currentStep}.`);
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
  const lines = [`Current page: ${kindLabel} "${ctx.title || 'unknown'}".`];
  if (Array.isArray(ctx.tutorials) && ctx.tutorials.length) {
    const list = ctx.tutorials.map((t, i) => `${i + 1}. ${t.title}`).join('\n');
    lines.push(`Contained tutorials:\n${list}`);
  }
  lines.push(`Explain the path, prerequisites, and suggest the next logical tutorial.`);
  return lines.join('\n');
}

function pageLayer(pageContext) {
  switch (pageContext?.kind) {
    case 'tutorial': return tutorialLayer(pageContext);
    case 'search':   return searchLayer(pageContext);
    case 'mission':  return collectionLayer(pageContext, 'mission');
    case 'group':    return collectionLayer(pageContext, 'group');
    default:         return 'Use searchTutorials liberally to ground answers.';
  }
}

function userLayer(user) {
  if (!user || !user.firstName) return '';
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ');
  return `The user's name is ${name}. Use it sparingly.`;
}

export function buildSystemPrompt(pageContext, user) {
  return [PERSONA, pageLayer(pageContext), userLayer(user)].filter(Boolean).join('\n\n');
}
