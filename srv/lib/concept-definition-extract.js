// srv/lib/concept-definition-extract.js
//
// #2426: generates a short markdown DEFINITION for one KG concept, grounded in
// the concept's already-linked authoritative sources (help docs + api docs +
// the tutorials that teach it), so the model summarizes real SAP material
// rather than inventing terminology. Output lands in Concepts.description with
// descriptionStatus='DRAFT' — it is NEVER auto-published; an admin approves it
// through the review gate added in PR-2 (buildConceptsPayload only renders
// APPROVED text).
//
// Mirrors the help-doc-extract adapter: a MINIMAL bare JSON schema for the
// forced tool call, with all real constraints enforced in applyPostValidation.
// Delegates the LLM call to extractConceptsCore (kg-extract.js).

import { extractConceptsCore } from './kg-extract.js';
import { validateTerminology } from './concept-terminology-guard.js';

const MAX_DEFINITION_LEN = 1200;   // hard ceiling; column is String(5000)
const MIN_DEFINITION_LEN = 40;     // reject stubs / empty tool calls
const MAX_GROUNDING_ITEMS = 8;     // cap the prompt payload

// #2440: refusal signatures. When the concept name reached the model blank
// (a DB key-casing defect fed "CONCEPT: undefined"), the model returned a
// fluent refusal instead of a definition. Those paragraphs are non-null,
// in-range and clean-termed, so they slipped past length+terminology checks and
// were bulk-approved to prod. Reject any output matching these phrasings.
const REFUSAL_PATTERNS = Object.freeze([
  /concept name was not provided/i,
  /\bno concept name\b/i,
  /no valid concept name/i,
  /concept name (?:provided )?is\s+\**["“]?undefined/i,
  /concept provided is\s+\**["“]?undefined/i,
  /sources do not contain sufficient information/i,
  /do not contain enough information/i,
  /cannot be determined/i,
  /cannot be documented/i,
  /cannot be written/i,
  /insufficient information/i,
  /do not (?:define|describe) a single/i,
  /(?:for|define) an undefined concept/i,
  /concept ["“]?undefined["”]?/i,
  /(?:please )?(?:supply|provide) a valid concept name/i,
]);

// Bare `{type, required, properties}` — defaultCallModel wraps it into the
// OpenAI function-tool shape. No nullable fields (Claude refuses the tool
// call on `type: ['string','null']` — see help-doc-extract.js Bug 5 note).
export const KG_CONCEPT_DEFINITION_SCHEMA = Object.freeze({
  type: 'object',
  required: ['definition'],
  properties: {
    definition: { type: 'string', minLength: 1 },
  },
});

const SYSTEM_PROMPT = `
You are writing a short reference definition of an SAP developer concept for a
documentation site.

Write 2-4 sentences in Markdown. State plainly what the concept is and what a
developer uses it for. Ground every claim ONLY in the provided source snippets
— do not add facts that are not supported by them.

You may include up to 2 inline Markdown links, and only to URLs that appear in
the provided sources. Use current SAP terminology (for example, write
"ABAP SQL", never the deprecated "Open SQL").

Do not restate the concept name as a heading. Do not include lists or code
blocks. Output prose only.
`.trim();

function buildUserPrompt({ concept, grounding }) {
  const sources = grounding.slice(0, MAX_GROUNDING_ITEMS).map((g, i) => {
    const bits = [`[S${i + 1}] ${g.title || g.name || 'source'}`];
    if (g.url) bits.push(`URL: ${g.url}`);
    if (g.snippet || g.description) bits.push(String(g.snippet || g.description).slice(0, 400));
    return bits.join('\n');
  }).join('\n\n');

  return `
CONCEPT: ${concept.name}${concept.slug ? ` (slug: ${concept.slug})` : ''}

SOURCES (ground the definition ONLY in these):
${sources || '(no sources provided)'}
`.trim();
}

/**
 * Validate the raw LLM definition. Returns the accepted string, or null when
 * it fails a hard rule (too short/long, empty, or contains deprecated
 * terminology). Rejection is intentional — a bad definition must not be
 * written even as a DRAFT.
 *
 * @param {string} raw
 * @returns {{ definition: string|null, reason: string|null, violations: Array }}
 */
export function applyPostValidation(raw) {
  const def = String(raw ?? '').trim();
  if (def.length < MIN_DEFINITION_LEN) {
    return { definition: null, reason: 'too-short', violations: [] };
  }
  if (def.length > MAX_DEFINITION_LEN) {
    return { definition: null, reason: 'too-long', violations: [] };
  }
  const term = validateTerminology(def);
  if (!term.ok) {
    return { definition: null, reason: 'stale-terminology', violations: term.violations };
  }
  if (REFUSAL_PATTERNS.some((re) => re.test(def))) {
    return { definition: null, reason: 'refusal', violations: [] };
  }
  return { definition: def, reason: null, violations: [] };
}

/**
 * Generate one concept definition. Grounding is REQUIRED — a concept with no
 * linked sources is skipped by the caller (never drafted blind).
 *
 * @param {object} args
 * @param {Function} args.callModel  ({system,user,schema}) => Promise<response>
 * @param {object}   args.concept    { slug, name }
 * @param {Array}    args.grounding  [{ title|name, url, snippet|description }]
 * @returns {Promise<{ definition: string|null, reason: string|null,
 *   violations: Array, promptTokens: number, completionTokens: number }>}
 */
export async function generateConceptDefinition({ callModel, concept, grounding = [] }) {
  // #2440: never send the model a blank name. The prod incident was a fluent
  // refusal ("the concept name was not provided…") triggered by CONCEPT:
  // undefined. Fail loud here rather than emit a garbage prompt — the caller
  // counts this as a rejection, never writes it, and the concept is retried
  // once its name is populated correctly.
  const name = typeof concept?.name === 'string' ? concept.name.trim() : '';
  if (!name) {
    return { definition: null, reason: 'no-name', violations: [], promptTokens: 0, completionTokens: 0 };
  }
  const user = buildUserPrompt({ concept, grounding });
  const { verdict, tokenUsage } = await extractConceptsCore({
    system: SYSTEM_PROMPT,
    user,
    schema: KG_CONCEPT_DEFINITION_SCHEMA,
    callModel,
  });
  const { definition, reason, violations } = applyPostValidation(verdict?.definition ?? '');
  return {
    definition,
    reason,
    violations,
    promptTokens: tokenUsage?.prompt ?? 0,
    completionTokens: tokenUsage?.completion ?? 0,
  };
}
