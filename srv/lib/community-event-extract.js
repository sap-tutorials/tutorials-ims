// srv/lib/community-event-extract.js
// Phase 4.8 (#765): LLM adapter for SAP community events. Single predicate
// `covers`. Cap 6 concepts/event, floor 0.7 confidence, K=15 registry hint.
//
// Mirrors help-doc-extract in structure but without the anchor semantic.
// Post-validation lives here (floor, cap, min-name, slug shape). See spec
// docs/superpowers/specs/2026-07-03-765-phase4.8-community-events.md §5.

const CAP_CONCEPTS = 6;
const FLOOR_CONFIDENCE = 0.7;
const MIN_NAME_LEN = 2;

const SYSTEM_PROMPT = `You classify SAP community events by which technical concepts they cover.
Return JSON: {"concepts":[{"slug":"kebab-slug","name":"Concept Name","description":"one sentence","confidence":0.0-1.0}]}.
- Use existing slugs when you recognize a match from the nearest-concepts list.
- Emit at most ${CAP_CONCEPTS} concepts.
- Only emit concepts with confidence >= ${FLOOR_CONFIDENCE}.
- Do NOT invent locations, times, or capacity; focus purely on the technical concept coverage.`;

export async function extractConceptsFromCommunityEvent({ event, nearestConcepts, callModel }) {
  const userPrompt = [
    `Event title: ${event.title}`,
    event.description ? `Description: ${event.description}` : null,
    `Type: ${event.eventType}`,
    event.location ? `Location: ${event.location}` : null,
    event.startDate ? `Date: ${event.startDate}` : null,
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
