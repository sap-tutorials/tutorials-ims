// srv/lib/devtoberfest-session-extract.js
// Issue #2311: LLM adapter for Devtoberfest Planner sessions. Single predicate
// `presents` — a session presents the technical concepts its abstract covers.
// Cap 6 concepts/session, floor 0.7 confidence, K=15 registry hint.
//
// Model-call + response-parse + post-validation are shared with the community-
// event and TechEd adapters via srv/lib/concept-covers-extract.js, which routes
// through extractConceptsCore() and the real defaultCallModel contract
// ({ system, user, schema }) => { verdict, promptTokens, completionTokens }.
// This module only owns the Devtoberfest-specific prompts (title + abstract +
// speaker(s) + optional linked tutorial).

import {
  CAP_CONCEPTS,
  FLOOR_CONFIDENCE,
  nearestConceptLines,
  extractCoversConcepts,
} from './concept-covers-extract.js';

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
    ...nearestConceptLines(nearestConcepts),
  ].filter(Boolean).join('\n');

  return extractCoversConcepts({ system: SYSTEM_PROMPT, user: userPrompt, callModel });
}
