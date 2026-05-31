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
completionWeek. Allowed measures: count, distinctUsers.

Date filters MUST set \`field\` to a date-trunc dimension name
(\`completionMonth\` or \`completionWeek\`), not a column name. Examples:
- "completions in the last 7 days" →
  \`{ fact: 'completion', filters: [{ field: 'completionWeek', op: 'sinceDays', value: 7 }] }\`
- "completions per week for the last 30 days" →
  \`{ fact: 'completion', groupBy: ['completionWeek'], filters: [{ field: 'completionWeek', op: 'sinceDays', value: 30 }] }\`
- "completions between two dates" →
  \`{ fact: 'completion', filters: [{ field: 'completionMonth', op: 'between', value: ['2026-01-01','2026-03-31'] }] }\`

The system enforces k-anonymity (cells with fewer than 5 distinct users are
suppressed) and never exposes user identity. If a question cannot be
expressed within this schema, say so plainly rather than guessing.

Never include credentials, API keys, or production URLs in responses.`;

const RAG_GUIDANCE = `When the getRelevantSteps tool returns step excerpts, treat them as authoritative ground truth for the question. Quote them naturally and cite each step inline using the form [tutorial-slug #stepNumber]. If no relevant steps come back (empty hits or all below the threshold), say so explicitly rather than guessing — invite the user to refine the question or use the searchTutorials tool to discover candidates.`;

const PROGRESS_GUIDANCE = `The signed-in user has tutorial-progress state available via the getUserProgress tool. Call it whenever:
- the user asks to resume, "where did I leave off", "continue", "what was I working on"
- the user asks for a recommendation ("what should I learn next", "suggest a tutorial")
- you are about to recommend tutorials and want to avoid re-suggesting finished ones

Apply these rules to recommendations and search results:
1. NEVER suggest a tutorial whose slug is in completedSlugs (or a mission/group in their respective lists). If the user explicitly asks for it, acknowledge they already finished it before answering.
2. PRIORITIZE in-progress tutorials. If the user has any, lead with "You have N tutorials in progress — want to resume <most-recent-title>? You're at <progressPercent>%." before suggesting anything new.
3. The searchTutorials tool annotates each hit with userStatus ('new' | 'in-progress' | 'completed'). Filter or downrank 'completed', boost 'in-progress', and prefer 'new' for fresh recommendations.
4. If getUserProgress returns empty arrays the user is anonymous or has no history — suggest beginner content rather than asking them to log in.`;

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
  if (ctx.tool === 'analytics-builder') {
    if (ctx.currentSpec && typeof ctx.currentSpec === 'object') {
      const s = ctx.currentSpec;
      const fromLine = s.from ? `${s.from.entity} ${s.from.alias}` : '(no entity)';
      const cols = Array.isArray(s.select) ? s.select.length : 0;
      const filt = s.filterTree ? 'filters: yes' : 'filters: none';
      const grp = Array.isArray(s.groupBy) && s.groupBy.length ? `groupBy: ${s.groupBy.length}` : 'groupBy: none';
      lines.push(`Current spec: FROM ${fromLine}, ${cols} select chips, ${filt}, ${grp}, limit ${s.limit ?? 'unset'}.`);
    } else {
      lines.push('User is starting from a blank query.');
    }
    if (ctx.lastResult && typeof ctx.lastResult === 'object') {
      const r = ctx.lastResult;
      const colList = Array.isArray(r.columns) ? r.columns.join(', ') : '(no columns)';
      lines.push(`Last result: ${r.rowCount ?? 0} rows${r.truncated ? ' (truncated)' : ''}, columns: ${colList}.`);
    }
    lines.push('Use the `generateAnalyticsQuery` tool to translate natural-language requests into a QuerySpec. Use the `explainAnalyticsResult` tool to summarize a result the user has just run. When refining, copy the user\'s current spec and modify only what changed.');
    lines.push('You may call searchAdminDocs, searchTutorials, analyticsQuery, generateAnalyticsQuery, or explainAnalyticsResult. Never expose user identity, email, or request IP.');
  } else {
    lines.push('You may call searchAdminDocs, searchTutorials, or analyticsQuery. Never expose user identity, email, or request IP.');
  }
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
  const isAdmin = pageContext?.kind === 'admin';
  const persona = isAdmin ? ADMIN_PERSONA : PERSONA;
  const layers = [persona, RAG_GUIDANCE];
  if (!isAdmin) layers.push(PROGRESS_GUIDANCE);
  layers.push(pageLayer(pageContext), userLayer(user));
  return layers.filter(Boolean).join('\n\n');
}
