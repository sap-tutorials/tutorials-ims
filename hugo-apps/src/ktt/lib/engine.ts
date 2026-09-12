/**
 * KTT Lesson Engine — pure TypeScript, no DOM/Vue dependencies.
 *
 * Manages session state for a single KTT lesson: beat queue, XP scoring,
 * and wrong-answer re-queue logic (re-queue at most once per beat).
 */

// ---------------------------------------------------------------------------
// Minimal local types — do NOT import from scripts/; keep the island self-contained.
// ---------------------------------------------------------------------------

export interface KttStoryBeat {
  type: 'story';
  kasimir: string;
  mood: string;
}

export interface KttDrillBeat {
  type: 'drill';
  kind: 'mc' | 'type';
  tla: string;
  prompt: string;
  answer: string;
  distractors: string[];
  kasimirRight: string;
  kasimirWrong: string;
}

export type KttBeat = KttStoryBeat | KttDrillBeat;

export interface KttLesson {
  id: string;
  legacyId: number;
  title: string;
  acronyms: string[];
  beats: KttBeat[];
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface Session {
  beats: KttBeat[];
  /** Current position within `queue` (index into queue array, not beat index). */
  index: number;
  xp: number;
  correct: number;
  wrong: number;
  /** Ordered list of beat indices still to visit. */
  queue: number[];
  /** Tracks which beat indices have already been re-queued (re-queue once limit). */
  requeuedSet: Set<number>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const XP_PER_CORRECT = 10;

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/** Create a fresh session for the given lesson. */
export function createSession(lesson: KttLesson): Session {
  const queue = lesson.beats.map((_, i) => i);
  return {
    beats: lesson.beats,
    index: 0,
    xp: 0,
    correct: 0,
    wrong: 0,
    queue,
    requeuedSet: new Set(),
  };
}

/** Return the beat at the current queue position, or null when exhausted. */
export function currentBeat(s: Session): KttBeat | null {
  if (s.index >= s.queue.length) return null;
  return s.beats[s.queue[s.index]] ?? null;
}

/**
 * Evaluate an answer against the current beat.
 *
 * - Only meaningful for `drill` beats; story beats always return `{ correct: false, requeued: false }`.
 * - Comparison is case-insensitive (trim + toLowerCase).
 * - Correct: increment `correct`, add XP_PER_CORRECT to `xp`.
 * - Wrong: increment `wrong`; push beat index to end of queue ONCE (tracked via requeuedSet).
 */
export function answerDrill(s: Session, answer: string): { correct: boolean; requeued: boolean } {
  const beat = currentBeat(s);
  if (!beat || beat.type !== 'drill') {
    return { correct: false, requeued: false };
  }

  const isCorrect = answer.trim().toLowerCase() === beat.answer.trim().toLowerCase();

  if (isCorrect) {
    s.correct += 1;
    s.xp += XP_PER_CORRECT;
    return { correct: true, requeued: false };
  }

  // Wrong answer
  s.wrong += 1;
  const beatIndex = s.queue[s.index];
  if (!s.requeuedSet.has(beatIndex)) {
    s.requeuedSet.add(beatIndex);
    s.queue.push(beatIndex);
    return { correct: false, requeued: true };
  }

  return { correct: false, requeued: false };
}

/** Advance to the next beat in the queue. */
export function advance(s: Session): void {
  if (s.index < s.queue.length) {
    s.index += 1;
  }
}

/** Return true when all beats in the queue have been visited. */
export function isComplete(s: Session): boolean {
  return currentBeat(s) === null;
}
