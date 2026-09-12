import { describe, it, expect } from 'vitest';
import { createSession, currentBeat, answerDrill, advance, isComplete, XP_PER_CORRECT } from '../lib/engine';

const lesson = { id: 'core-1', legacyId: 90001, title: 't', acronyms: [], beats: [
  { type: 'story', kasimir: 'hi', mood: 'teaching' },
  { type: 'drill', kind: 'mc', tla: 'BTP', prompt: '?', answer: 'Business Technology Platform',
    distractors: ['a','b'], kasimirRight: 'y', kasimirWrong: 'n' },
]} as any;

describe('engine', () => {
  it('awards XP on correct and re-queues on wrong', () => {
    const s = createSession(lesson);
    advance(s); // move past story to drill
    expect(currentBeat(s).type).toBe('drill');
    const wrong = answerDrill(s, 'a');
    expect(wrong.correct).toBe(false);
    expect(wrong.requeued).toBe(true);
    advance(s);
    const right = answerDrill(s, 'Business Technology Platform');
    expect(right.correct).toBe(true);
    expect(s.xp).toBe(XP_PER_CORRECT);
    advance(s);
    expect(isComplete(s)).toBe(true);
  });

  it('re-queues at most once (second wrong answer not re-queued)', () => {
    const s = createSession(lesson);
    advance(s); // skip story beat
    const first = answerDrill(s, 'wrong-answer');
    expect(first.requeued).toBe(true);
    // queue is now [1] at end; advance to reach re-queued beat
    advance(s);
    const second = answerDrill(s, 'still-wrong');
    expect(second.correct).toBe(false);
    expect(second.requeued).toBe(false); // NOT re-queued again
    expect(s.wrong).toBe(2);
  });

  it('case-insensitive answer matching', () => {
    const s = createSession(lesson);
    advance(s); // skip story beat
    const r = answerDrill(s, 'BUSINESS TECHNOLOGY PLATFORM');
    expect(r.correct).toBe(true);
    expect(s.xp).toBe(XP_PER_CORRECT);
  });

  it('answerDrill on a story beat returns not-correct, not-requeued', () => {
    const s = createSession(lesson);
    // index=0 is the story beat
    const r = answerDrill(s, 'anything');
    expect(r.correct).toBe(false);
    expect(r.requeued).toBe(false);
  });
});
