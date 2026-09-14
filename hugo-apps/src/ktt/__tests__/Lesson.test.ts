// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import Lesson from '../components/Lesson.vue';

// Stub server.ts — best-effort calls must never throw into the UI
vi.mock('../lib/server', () => ({
  isAuthenticated: vi.fn().mockResolvedValue(false),
  completeLesson: vi.fn().mockResolvedValue(null),
  syncProgress: vi.fn().mockResolvedValue(null),
  fetchBanter: vi.fn().mockResolvedValue(null),
}));

const storyLesson = {
  id: 'core-1',
  legacyId: 90001,
  title: 'Meet BTP',
  acronyms: ['BTP'],
  beats: [
    { type: 'story', kasimir: 'BTP stands for Business Technology Platform!', mood: 'teaching' },
    {
      type: 'drill',
      kind: 'mc',
      tla: 'BTP',
      prompt: 'What does BTP stand for?',
      answer: 'Business Technology Platform',
      distractors: ['Better Tech Portal', 'Basic Trial Program'],
      kasimirRight: 'Correct!',
      kasimirWrong: 'Try again…',
    },
  ],
};

// Lesson with two drills — for XP credit testing
const twoDrillLesson = {
  id: 'core-2',
  legacyId: 90002,
  title: 'Two Drills',
  acronyms: ['BTP', 'SAP'],
  beats: [
    {
      type: 'drill',
      kind: 'mc',
      tla: 'BTP',
      prompt: 'What is BTP?',
      answer: 'Business Technology Platform',
      distractors: ['Better Tech Portal'],
      kasimirRight: 'Yes!',
      kasimirWrong: 'Nope',
    },
    {
      type: 'drill',
      kind: 'mc',
      tla: 'SAP',
      prompt: 'What is SAP?',
      answer: 'Systems Applications Products',
      distractors: ['Some App Platform'],
      kasimirRight: 'Right!',
      kasimirWrong: 'Wrong',
    },
  ],
};

describe('Lesson', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders current story beat text initially', () => {
    const w = mount(Lesson, { props: { lesson: storyLesson } });
    expect(w.text()).toContain('BTP stands for Business Technology Platform!');
  });

  it('KasimirStage has teaching mood on story beat', () => {
    const w = mount(Lesson, { props: { lesson: storyLesson } });
    // KasimirStage renders div.kasimir--<mood>
    expect(w.find('.kasimir--teaching').exists()).toBe(true);
  });

  it('shows Next button on story beat and advances to drill on click', async () => {
    const w = mount(Lesson, { props: { lesson: storyLesson } });
    const btn = w.find('[data-testid="ktt-next"]');
    expect(btn.exists()).toBe(true);
    await btn.trigger('click');
    // Should now show drill beat UI
    expect(w.text()).toContain('What does BTP stand for?');
  });

  it('shows answer choices on drill beat', async () => {
    const w = mount(Lesson, { props: { lesson: storyLesson } });
    // advance past story
    await w.find('[data-testid="ktt-next"]').trigger('click');
    // Should show the correct answer and distractors as buttons
    expect(w.find('[data-testid="ktt-choice"]').exists()).toBe(true);
  });

  it('correct answer shows correct mood and XP, then emits complete with lessonId and xp', async () => {
    const w = mount(Lesson, { props: { lesson: storyLesson } });
    // advance past story beat
    await w.find('[data-testid="ktt-next"]').trigger('click');
    // click the correct answer choice — select by text, not index (shuffle-safe)
    const choices = w.findAll('[data-testid="ktt-choice"]');
    const correct = choices.find(c => c.text() === 'Business Technology Platform');
    expect(correct).toBeTruthy();
    await correct!.trigger('click');
    // Kasimir should show correct mood
    expect(w.find('.kasimir--correct').exists()).toBe(true);
    // advance to completion
    await w.find('[data-testid="ktt-next"]').trigger('click');
    // Allow a tick for any async work
    await new Promise(r => setTimeout(r, 0));
    expect(w.emitted('complete')).toBeTruthy();
    // 1A: emits a payload — one correct drill of one = 10 XP, passed
    expect(w.emitted('complete')![0]).toEqual([
      { lessonId: 'core-1', xp: 10, passed: true, correct: 1, total: 1 },
    ]);
  });

  it('wrong answer shows wrong mood and does not emit complete', async () => {
    const w = mount(Lesson, { props: { lesson: storyLesson } });
    await w.find('[data-testid="ktt-next"]').trigger('click');
    const choices = w.findAll('[data-testid="ktt-choice"]');
    const wrong = choices.find(c => c.text() === 'Better Tech Portal');
    expect(wrong).toBeTruthy();
    await wrong!.trigger('click');
    expect(w.find('.kasimir--wrong').exists()).toBe(true);
    expect(w.emitted('complete')).toBeFalsy();
  });

  it('shows celebrate mood on lesson completion', async () => {
    const w = mount(Lesson, { props: { lesson: storyLesson } });
    // advance past story
    await w.find('[data-testid="ktt-next"]').trigger('click');
    // answer correctly — select by text (shuffle-safe)
    const choices = w.findAll('[data-testid="ktt-choice"]');
    await choices.find(c => c.text() === 'Business Technology Platform')!.trigger('click');
    // advance
    await w.find('[data-testid="ktt-next"]').trigger('click');
    await new Promise(r => setTimeout(r, 0));
    // When complete, celebrate mood should appear
    expect(w.find('.kasimir--celebrate').exists()).toBe(true);
  });

  it('displays earned XP during lesson', async () => {
    const w = mount(Lesson, { props: { lesson: storyLesson } });
    await w.find('[data-testid="ktt-next"]').trigger('click');
    const choices = w.findAll('[data-testid="ktt-choice"]');
    // Select by text — shuffle-safe
    await choices.find(c => c.text() === 'Business Technology Platform')!.trigger('click');
    // Should show XP
    expect(w.text()).toContain('10');
  });

  // 1A: multi-drill lesson credits the true earned XP
  it('two-drill lesson emits complete with accumulated XP (20)', async () => {
    const w = mount(Lesson, { props: { lesson: twoDrillLesson } });

    // Answer first drill correctly (select by text)
    let choices = w.findAll('[data-testid="ktt-choice"]');
    await choices.find(c => c.text() === 'Business Technology Platform')!.trigger('click');
    await w.find('[data-testid="ktt-next"]').trigger('click');

    // Answer second drill correctly (select by text)
    choices = w.findAll('[data-testid="ktt-choice"]');
    await choices.find(c => c.text() === 'Systems Applications Products')!.trigger('click');
    await w.find('[data-testid="ktt-next"]').trigger('click');

    await new Promise(r => setTimeout(r, 0));
    expect(w.emitted('complete')).toBeTruthy();
    // Two correct answers = 20 XP, both drills right → passed
    expect(w.emitted('complete')![0]).toEqual([
      { lessonId: 'core-2', xp: 20, passed: true, correct: 2, total: 2 },
    ]);
  });

  // 1B: the emitted XP is the session delta (sessionXp), not a floor
  it('emitted XP equals session earned XP (delta), not a hardcoded floor', async () => {
    const w = mount(Lesson, { props: { lesson: twoDrillLesson } });
    // Answer first correctly, second wrongly then correctly (requeue logic)
    let choices = w.findAll('[data-testid="ktt-choice"]');
    await choices.find(c => c.text() === 'Business Technology Platform')!.trigger('click');
    await w.find('[data-testid="ktt-next"]').trigger('click');

    // Answer second wrong first
    choices = w.findAll('[data-testid="ktt-choice"]');
    await choices.find(c => c.text() === 'Some App Platform')!.trigger('click');
    await w.find('[data-testid="ktt-next"]').trigger('click');

    // Now re-queued — answer correctly
    choices = w.findAll('[data-testid="ktt-choice"]');
    await choices.find(c => c.text() === 'Systems Applications Products')!.trigger('click');
    await w.find('[data-testid="ktt-next"]').trigger('click');

    await new Promise(r => setTimeout(r, 0));
    expect(w.emitted('complete')).toBeTruthy();
    // Only 2 correct answers (10 each) despite 3 total attempts
    const payload = w.emitted('complete')![0][0] as { xp: number };
    expect(payload.xp).toBe(20);
    // It's definitely NOT the hardcoded floor of 10
    expect(payload.xp).toBeGreaterThanOrEqual(10);
  });

  it('emits passed:false with the score when below the 70% threshold', async () => {
    const w = mount(Lesson, { props: { lesson: twoDrillLesson } });
    // Answer first wrong twice (re-queued once, second wrong sticks)
    let choices = w.findAll('[data-testid="ktt-choice"]');
    await choices.find(c => c.text() === 'Better Tech Portal')!.trigger('click');
    await w.find('[data-testid="ktt-next"]').trigger('click');

    // Answer second correctly
    choices = w.findAll('[data-testid="ktt-choice"]');
    await choices.find(c => c.text() === 'Systems Applications Products')!.trigger('click');
    await w.find('[data-testid="ktt-next"]').trigger('click');

    // The first drill was re-queued to the end — answer it wrong again
    choices = w.findAll('[data-testid="ktt-choice"]');
    await choices.find(c => c.text() === 'Better Tech Portal')!.trigger('click');
    await w.find('[data-testid="ktt-next"]').trigger('click');

    await new Promise(r => setTimeout(r, 0));
    expect(w.emitted('complete')).toBeTruthy();
    // 1 of 2 correct = 50% < 70% → not passed
    expect(w.emitted('complete')![0]).toEqual([
      { lessonId: 'core-2', xp: 10, passed: false, correct: 1, total: 2 },
    ]);
    // Not a celebration
    expect(w.find('.kasimir--celebrate').exists()).toBe(false);
  });
});
