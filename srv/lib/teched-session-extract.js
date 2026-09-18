// srv/lib/teched-session-extract.js
// Issue #2312: LLM adapter for SAP TechEd sessions. Single predicate `covers`
// — a session covers the technical concepts its title/abstract describes.
// Cap 6 concepts/session, floor 0.7 confidence, K=15 registry hint.
//
// Model-call + response-parse + post-validation are shared with the community-
// event adapter via srv/lib/concept-covers-extract.js, which routes through
// extractConceptsCore() and the real defaultCallModel contract
// ({ system, user, schema }) => { verdict, promptTokens, completionTokens }.
// This module only owns the TechEd-specific prompts (title + abstract + track
// + speaker(s)).

import {
  CAP_CONCEPTS,
  FLOOR_CONFIDENCE,
  nearestConceptLines,
  extractCoversConcepts,
} from './concept-covers-extract.js';

const SYSTEM_PROMPT = `You classify SAP TechEd conference sessions by which technical concepts they cover.
Return JSON: {"concepts":[{"slug":"kebab-slug","name":"Concept Name","description":"one sentence","confidence":0.0-1.0}]}.
- Use existing slugs when you recognize a match from the nearest-concepts list.
- Emit at most ${CAP_CONCEPTS} concepts.
- Only emit concepts with confidence >= ${FLOOR_CONFIDENCE}.
- Focus on the technical concepts the session teaches or demonstrates. Do NOT invent speakers, times, or products not mentioned.`;

export async function extractConceptsFromTechEdSession({ session, nearestConcepts, callModel }) {
  const userPrompt = [
    `Session title: ${session.title}`,
    session.description ? `Abstract: ${session.description}` : null,
    session.track ? `Track: ${session.track}` : null,
    session.speakerNames ? `Speaker(s): ${session.speakerNames}` : null,
    '',
    ...nearestConceptLines(nearestConcepts),
  ].filter(Boolean).join('\n');

  return extractCoversConcepts({ system: SYSTEM_PROMPT, user: userPrompt, callModel });
}
