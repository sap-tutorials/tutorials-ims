// Pure helper module for the validation widget (issue #212).
// No DOM access, no localStorage access here — those happen in the
// Vue component which calls into this module's functions.
//
// Note: client-side correctAnswer comparison is a documented trade-off.
// The correctAnswer ships in the public <script id="tutorial-data"> JSON
// for every tutorial; this module just consumes it. Server-side grading
// is #209's territory (AI grader).

export interface ValidationQuestion {
  id: string;
  question: string;
  type: 'multiple-choice' | 'text';
  options?: string[];
  // [#1740] Choice cardinality for MCQ. 'single' → radio (one correct);
  // 'multiple' → checkbox (exact set match against correctAnswers).
  // Absent → treated as 'single' (backward compat with pre-#1740 payloads
  // and AI-authored MCQ, which are always single-answer).
  choiceMode?: 'single' | 'multiple';
  // Optional because AI-graded questions (`aiGrading: true`) ship with no
  // correctAnswer — the reference answer lives server-side in
  // ValidateAnswerSpecs (#209). Also omitted for multi-select questions,
  // which carry their reference set in `correctAnswers` (#1740).
  // gradeAnswers defends against undefined via `?? ''` but expects callers to
  // partition AI-graded questions out via isAiGraded() before invoking
  // gradeAnswers.
  correctAnswer?: string;
  // [#1740] Full set of correct options for a multi-select question. Present
  // only when choiceMode === 'multiple'. Grading is exact set match.
  correctAnswers?: string[];
  // When `true`, the question is graded server-side via /api/validate-answer
  // (AI grader, #209). Local-grading helpers in this module skip these.
  aiGrading?: boolean;
}

export interface GradingResult {
  correct: boolean;
  perQuestion: Array<{ id: string; correct: boolean }>;
}

/**
 * Returns true iff the question is flagged for server-side AI grading.
 * Strict-true equality: HANA can return integers (0/1) for booleans, so
 * the loader must coerce to a real JS boolean before reaching this helper.
 * That keeps a stray `1` from accidentally routing through the AI grader.
 */
export function isAiGraded(q: ValidationQuestion): boolean {
  return q.aiGrading === true;
}

/**
 * Grade an answer set against a question set. Pure: no I/O.
 * Multiple-choice (single): exact equality.
 * Multiple-choice (choiceMode 'multiple'): exact SET match — every option in
 *   `correctAnswers` must be selected and no other option chosen (#1740). The
 *   submitted value for a multi-select is an array of selected option strings.
 * Text: case-insensitive equality after trim.
 * All-or-nothing aggregation: a single quiz's `correct` is true iff every
 * question is correct (the legacy widget's behaviour, preserved for #212).
 *
 * Defensive: a missing or undefined `correctAnswer` (e.g., from a stale
 * ValidationQuestion that slipped past the AI/local partition in
 * Validation.vue) coerces to '' and grades any submission as incorrect.
 * Callers should still partition AI-graded questions via isAiGraded() —
 * this guard is belt-and-braces, not a license to skip the partition.
 */
export function gradeAnswers(
  questions: ValidationQuestion[],
  answers: Record<string, string | string[]>
): GradingResult {
  const perQuestion = questions.map(q => {
    const raw = answers[q.id];

    // [#1740] Multi-select: compare the submitted set to the correct set.
    if (q.type === 'multiple-choice' && q.choiceMode === 'multiple') {
      const submittedSet = new Set(
        (Array.isArray(raw) ? raw : raw ? [raw] : [])
          .map(s => s.trim())
          .filter(Boolean)
      );
      const correctSet = new Set((q.correctAnswers ?? []).map(s => s.trim()).filter(Boolean));
      const correct =
        correctSet.size > 0 &&
        submittedSet.size === correctSet.size &&
        [...correctSet].every(c => submittedSet.has(c));
      return { id: q.id, correct };
    }

    // Single-select / text: scalar comparison. Coerce a stray array to its
    // first element so a mis-shaped answer map can't throw.
    const submitted = (Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '')).trim();
    const correct = q.correctAnswer ?? '';
    if (q.type === 'multiple-choice') {
      return { id: q.id, correct: submitted === correct };
    }
    return {
      id: q.id,
      correct: submitted.toLowerCase() === correct.toLowerCase()
    };
  });
  return { correct: perQuestion.every(r => r.correct), perQuestion };
}

const PERSIST_PREFIX = 'tutorial-validation-';

export function persistKey(slug: string, stepNumber: number): string {
  return `${PERSIST_PREFIX}${slug}-${stepNumber}`;
}

/**
 * Read the persisted "answered correctly" flag for a (slug, step).
 * Tolerant of localStorage failures (private mode, quota); returns null on any error
 * including malformed JSON.
 */
export function readPersisted(slug: string, stepNumber: number): { correct: boolean } | null {
  try {
    const raw = localStorage.getItem(persistKey(slug, stepNumber));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.correct === true ? { correct: true } : null;
  } catch {
    return null;
  }
}

/**
 * Write the "answered correctly" flag. Only persists on `correct: true`.
 * Silent on failure (private mode, quota exceeded, etc).
 */
export function writePersisted(slug: string, stepNumber: number, correct: boolean): void {
  if (!correct) return;
  try {
    localStorage.setItem(
      persistKey(slug, stepNumber),
      JSON.stringify({ correct: true, timestamp: Date.now() })
    );
  } catch {
    // private mode or quota exceeded — silent
  }
}
