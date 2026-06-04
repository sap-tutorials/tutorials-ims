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
  correctAnswer: string;
  aiGrading?: boolean; // reserved for #209
}

export interface GradingResult {
  correct: boolean;
  perQuestion: Array<{ id: string; correct: boolean }>;
}

/**
 * Grade an answer set against a question set. Pure: no I/O.
 * Multiple-choice: exact equality.
 * Text: case-insensitive equality after trim.
 * All-or-nothing aggregation: a single quiz's `correct` is true iff every
 * question is correct (the legacy widget's behaviour, preserved for #212).
 */
export function gradeAnswers(
  questions: ValidationQuestion[],
  answers: Record<string, string>
): GradingResult {
  const perQuestion = questions.map(q => {
    const submitted = (answers[q.id] ?? '').trim();
    if (q.type === 'multiple-choice') {
      return { id: q.id, correct: submitted === q.correctAnswer };
    }
    return {
      id: q.id,
      correct: submitted.toLowerCase() === q.correctAnswer.toLowerCase()
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
