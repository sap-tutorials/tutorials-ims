'use strict';
// Pure classification logic for the BTP→BAIP audit: builds the LLM prompt and
// parses the reply. No I/O, no SDK — so the rename rules are unit-testable.

const VALID_ACTIONS = Object.freeze(['REPLACE', 'KEEP', 'STRIP_PREFIX', 'NEEDS_REVIEW']);

const SYSTEM_PROMPT = [
  'You audit SAP marketing/UI copy for the rename of "SAP BTP" to the',
  '"Business AI Platform". For ONE text field, decide exactly ONE action and,',
  'when rewriting, return the FULL new field value (not a diff).',
  '',
  'Rules:',
  '1. REPLACE — a standalone reference to the platform itself ("BTP", "SAP BTP",',
  '   "Business Technology Platform"). Rewrite to "SAP Business AI Platform" for',
  '   the first/most prominent mention in the field, and "Business AI Platform"',
  '   for any later mentions. NEVER abbreviate to "BAIP".',
  '2. KEEP — recognised product/tool names stay verbatim: "BTP Cockpit",',
  '   "BTP CLI". If the only BTP reference is such a tool name, action is KEEP.',
  '3. STRIP_PREFIX — a service named "SAP BTP, <service>" or "SAP BTP <service>"',
  '   becomes just "<service>" (drop the "SAP BTP" prefix and any comma).',
  '4. NEEDS_REVIEW — anything ambiguous, novel phrasing, or a possible new/unknown',
  '   tool name you are not confident about. Do NOT guess.',
  '',
  'A single field may need REPLACE even if it also contains a kept tool name —',
  'rewrite the platform refs, keep the tool name.',
  '',
  'Respond with ONLY a JSON object, no prose:',
  '{"action":"REPLACE|KEEP|STRIP_PREFIX|NEEDS_REVIEW",',
  ' "newValue":"<full new text, or null for KEEP/NEEDS_REVIEW>",',
  ' "rationale":"<one short sentence>"}',
].join('\n');

function buildMessages(candidate) {
  const user = [
    `Entity: ${candidate.entity}`,
    `Field: ${candidate.field}`,
    'Current value (between <<< >>>):',
    `<<<${candidate.value}>>>`,
  ].join('\n');
  return { system: SYSTEM_PROMPT, user };
}

function stripFence(text) {
  if (typeof text !== 'string') return '';
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

function parseClassification(rawText, candidate) {
  const base = {
    entity: candidate.entity, key: candidate.key, field: candidate.field,
    oldValue: candidate.value,
  };
  let obj;
  try {
    obj = JSON.parse(stripFence(rawText));
  } catch (e) {
    return { ...base, action: 'NEEDS_REVIEW', newValue: null,
      rationale: `parse error: ${e.message}` };
  }
  const action = obj && typeof obj.action === 'string' ? obj.action.toUpperCase() : '';
  if (!VALID_ACTIONS.includes(action)) {
    return { ...base, action: 'NEEDS_REVIEW', newValue: null,
      rationale: `invalid action from model: ${JSON.stringify(obj && obj.action)}` };
  }
  const writes = action === 'REPLACE' || action === 'STRIP_PREFIX';
  const newValue = writes && typeof obj.newValue === 'string' ? obj.newValue : null;
  if (writes && newValue === null) {
    return { ...base, action: 'NEEDS_REVIEW', newValue: null,
      rationale: `model chose ${action} but returned no newValue` };
  }
  return { ...base, action, newValue,
    rationale: typeof obj.rationale === 'string' ? obj.rationale : '' };
}

module.exports = { VALID_ACTIONS, SYSTEM_PROMPT, buildMessages, parseClassification };
