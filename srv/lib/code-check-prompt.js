// srv/lib/code-check-prompt.js
// Pure module — no cds, no network, no fs.
// Consumed by the code-check dispatch handler (Task 1.7).

/** Prompt vintage tag so future spec rows can be analyzed against a known prompt. */
export const PROMPT_VERSION = 'v1';

/** Sliding-window size for reference-leak detection. */
const REDACT_WINDOW = 30;

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

/**
 * Returns the system prompt for the code-check LLM call.
 * Text is taken verbatim from spec §6.
 *
 * @returns {string}
 */
export function buildSystemPrompt() {
  return `You are a patient programming instructor reviewing a learner's code
submission for a single step of an SAP developer tutorial.

You will receive:
- The author's goal: what the code must accomplish.
- (Optional) The tutorial step's text for context.
- (Optional) The tutorial's example code from this step.
- (Optional) The author's reference solution. NEVER QUOTE IT.
- The learner's submitted code.

Return ONLY a JSON object matching the supplied schema. Rules:

1. Verdict scale:
   - "pass": the code accomplishes the goal. Style differences from the
     reference are FINE. The reference is a valid solution, not the only one.
   - "partial": the code is on the right track but misses something
     material (a needed clause, an edge case, a spec violation).
   - "fail": the code does not address the goal, OR addresses a different
     problem, OR has a syntax/runtime error that would prevent it from
     running at all.
   - When uncertain between pass and partial, prefer partial.
   - When uncertain between partial and fail, prefer partial.

2. summary: ONE sentence stating the verdict in plain language.
3. correctAspects: 1-3 specific things the learner did right.
   Empty array on fail.
4. suggestions: 1-3 specific, actionable next steps.
   Empty array on pass.
5. NEVER reveal the reference solution, even partially. Speak about
   approaches in general terms.
6. NEVER execute, simulate, or claim to have run the code.
7. NEVER fabricate compiler/runtime error messages. If syntax looks wrong,
   describe what looks wrong, don't invent the error.
8. If the submission is empty, gibberish, or clearly off-topic
   (e.g., a poem), return verdict "fail" with summary explaining you
   need actual code.
9. Output MUST validate against the schema. No extra fields, no markdown.`;
}

// ---------------------------------------------------------------------------
// User message builder
// ---------------------------------------------------------------------------

/**
 * Builds the deterministic-ordered user message for the code-check LLM call.
 * Optional sections are omitted entirely when absent (no placeholder headers).
 *
 * Section order (fixed):
 *   Goal → Hints → Step text → Tutorial's example code → Reference solution → Language hint → Learner's submission
 *
 * @param {object} opts
 * @param {string}  opts.goal             - What the code must accomplish (required).
 * @param {string[]} [opts.hints]         - Author-supplied hints (additional context for the grader).
 * @param {string} [opts.stepText]        - Tutorial step prose for context.
 * @param {string} [opts.tutorialSamples] - Example code shown in the tutorial step.
 * @param {string} [opts.referenceSolution] - Author's reference solution (NEVER QUOTE).
 * @param {string} [opts.language]        - Language hint for fenced code blocks.
 * @param {string}  opts.submittedCode    - The learner's code (required).
 * @returns {string}
 */
export function buildUserMessage({
  goal,
  hints,
  stepText,
  tutorialSamples,
  referenceSolution,
  language,
  submittedCode,
}) {
  const lang = language || '';
  const fence = (code) => `\`\`\`${lang}\n${code}\n\`\`\``;

  const parts = [];

  parts.push(`Goal:\n${goal}`);

  if (hints && hints.length > 0) {
    const bulletList = hints.map(h => `- ${h}`).join('\n');
    parts.push(`Hints (author-supplied, additional context):\n${bulletList}`);
  }

  if (stepText) {
    parts.push(`Step text (for context):\n${stepText}`);
  }

  if (tutorialSamples) {
    parts.push(`Tutorial's example code:\n${fence(tutorialSamples)}`);
  }

  if (referenceSolution) {
    parts.push(`Reference solution (DO NOT QUOTE — for your judgment only):\n${fence(referenceSolution)}`);
  }

  if (lang) {
    parts.push(`Language hint: ${lang}`);
  }

  parts.push(`Learner's submission:\n${fence(submittedCode)}`);

  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

/**
 * JSON schema for the forced tool-call output of the code-check LLM call.
 *
 * IMPORTANT: this schema is used as the `parameters` of a FORCED TOOL-CALL
 * (tool_choice: { type: 'tool', name: '...' }), NOT as `response_format`.
 * The OrchestrationClient in this codebase delivers structured output via
 * tool_choice — see generateAnalyticsQuery in srv/lib/chat-orchestrator.js
 * for the canonical pattern. Wiring this as response_format will silently
 * produce wrong output because the SDK exposes structured-output differently
 * per model version.
 *
 * @type {object}
 */
export const CHECK_CODE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary', 'correctAspects', 'suggestions'],
  properties: {
    verdict: {
      type: 'string',
      enum: ['pass', 'partial', 'fail'],
      description: 'Overall assessment of the learner\'s submission.',
    },
    summary: {
      type: 'string',
      maxLength: 400,
      description: 'One sentence stating the verdict in plain language.',
    },
    correctAspects: {
      type: 'array',
      maxItems: 3,
      items: { type: 'string', maxLength: 200 },
      description: '1-3 specific things the learner did right. Empty array on fail.',
    },
    suggestions: {
      type: 'array',
      maxItems: 3,
      items: { type: 'string', maxLength: 300 },
      description: '1-3 specific, actionable next steps. Empty array on pass.',
    },
  },
};

// ---------------------------------------------------------------------------
// Reference-leak guard
// ---------------------------------------------------------------------------

/**
 * Belt-and-braces guard: even if the model ignores "NEVER QUOTE IT", we
 * redact any field in the verdict that contains a 30-char substring of the
 * reference solution.
 *
 * Whitespace is collapsed on both sides before the substring check so that
 * formatting differences don't defeat detection.
 *
 * Returns the original verdict object UNCHANGED (same reference) when no
 * redaction is necessary.
 *
 * @param {object} verdict            - The parsed LLM output.
 * @param {string|null} referenceSolution
 * @returns {object} verdict (possibly mutated copy)
 */
export function redactReferenceLeaks(verdict, referenceSolution) {
  if (!referenceSolution) return verdict;

  const ref = referenceSolution.replace(/\s+/g, ' ');
  if (ref.length < REDACT_WINDOW) return verdict;

  /**
   * Returns true if `text` contains any 30-char window of `ref`.
   * @param {string} text
   */
  function hasLeak(text) {
    if (typeof text !== 'string') return false;
    const normalised = text.replace(/\s+/g, ' ');
    for (let i = 0; i + REDACT_WINDOW <= ref.length; i++) {
      if (normalised.includes(ref.slice(i, i + REDACT_WINDOW))) return true;
    }
    return false;
  }

  // Check whether any redaction is needed before copying.
  const summaryLeaks = hasLeak(verdict.summary);
  const suggestionLeaks = verdict.suggestions.map(hasLeak);
  const aspectLeaks = verdict.correctAspects.map(hasLeak);

  const needsRedaction =
    summaryLeaks ||
    suggestionLeaks.some(Boolean) ||
    aspectLeaks.some(Boolean);

  if (!needsRedaction) return verdict;

  // Shallow copy so we don't mutate the caller's object.
  return {
    ...verdict,
    summary: summaryLeaks ? '[redacted]' : verdict.summary,
    suggestions: verdict.suggestions.map((s, i) => suggestionLeaks[i] ? '[redacted]' : s),
    correctAspects: verdict.correctAspects.map((a, i) => aspectLeaks[i] ? '[redacted]' : a),
  };
}
