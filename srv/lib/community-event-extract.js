// srv/lib/community-event-extract.js
// Phase 4.8 (#765): LLM adapter for SAP community events. Single predicate
// `covers`. Cap 6 concepts/event, floor 0.7 confidence, K=15 registry hint.
//
// Model-call + response-parse + post-validation are shared with the TechEd
// adapter via srv/lib/concept-covers-extract.js, which routes through
// extractConceptsCore() and the real defaultCallModel contract
// ({ system, user, schema }) => { verdict, promptTokens, completionTokens }.
// This module only owns the community-event-specific prompts.
// Spec: docs/superpowers/specs/2026-07-03-765-phase4.8-community-events.md §5.

import {
  CAP_CONCEPTS,
  FLOOR_CONFIDENCE,
  nearestConceptLines,
  extractCoversConcepts,
} from './concept-covers-extract.js';

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
    ...nearestConceptLines(nearestConcepts),
  ].filter(Boolean).join('\n');

  return extractCoversConcepts({ system: SYSTEM_PROMPT, user: userPrompt, callModel });
}
