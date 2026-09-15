// srv/lib/devtoberfest-session-extract.js
// Issue #2311: LLM adapter for Devtoberfest Planner sessions. Single predicate
// `presents` — a session presents the technical concepts its abstract covers.
// Cap 6 concepts/session, floor 0.7 confidence, K=15 registry hint.
//
// Clone of srv/lib/community-event-extract.js (same post-validation: floor,
// cap, min-name, slug shape). Prompt is session-shaped: title + abstract +
// speaker(s) + optional linked tutorial, instead of event location/date.

const CAP_CONCEPTS = 6;
const FLOOR_CONFIDENCE = 0.7;
const MIN_NAME_LEN = 2;

const SYSTEM_PROMPT = `You classify SAP Devtoberfest conference sessions by which technical concepts they present.
Return JSON: {"concepts":[{"slug":"kebab-slug","name":"Concept Name","description":"one sentence","confidence":0.0-1.0}]}.
- Use existing slugs when you recognize a match from the nearest-concepts list.
- Emit at most ${CAP_CONCEPTS} concepts.
- Only emit concepts with confidence >= ${FLOOR_CONFIDENCE}.
- Focus on the technical concepts the session teaches or demonstrates. Do NOT invent speakers, times, or products not mentioned.`;

export async function extractConceptsFromDevtoberfestSession({ session, nearestConcepts, callModel }) {
  const userPrompt = [
    `Session title: ${session.title}`,
    session.description ? `Abstract: ${session.description}` : null,
    session.speakerNames ? `Speaker(s): ${session.speakerNames}` : null,
    session.activityTaskSlug ? `Linked tutorial/puzzle: ${session.activityTaskSlug}` : null,
    '',
    `Nearest concepts (choose from these when there's a good match; otherwise emit a new slug):`,
    ...(nearestConcepts ?? []).slice(0, 15).map(c => `- ${c.slug}: ${c.name}`),
  ].filter(Boolean).join('\n');

  const response = await callModel({
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
    max_tokens: 800,
  });

  const text = (response.content ?? []).find(b => b.type === 'text')?.text ?? '{}';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { concepts: [] };
  }
  const raw = Array.isArray(parsed.concepts) ? parsed.concepts : [];
  const filtered = [];
  for (const c of raw) {
    if (typeof c?.slug !== 'string' || c.slug.length < MIN_NAME_LEN) continue;
    if (typeof c?.name !== 'string' || c.name.length < MIN_NAME_LEN) continue;
    if (typeof c?.confidence !== 'number' || c.confidence < FLOOR_CONFIDENCE) continue;
    filtered.push({
      slug: c.slug.toLowerCase(),
      name: c.name.trim(),
      description: (c.description ?? '').trim(),
      confidence: c.confidence,
    });
    if (filtered.length >= CAP_CONCEPTS) break;
  }

  return {
    concepts: filtered,
    promptTokens: response.usage?.input_tokens ?? 0,
    completionTokens: response.usage?.output_tokens ?? 0,
  };
}
