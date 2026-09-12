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

  it('correct answer shows correct mood and XP, then emits complete', async () => {
    const w = mount(Lesson, { props: { lesson: storyLesson } });
    // advance past story beat
    await w.find('[data-testid="ktt-next"]').trigger('click');
    // click the correct answer choice
    const choices = w.findAll('[data-testid="ktt-choice"]');
    const correct = choices.find(c => c.text() === 'Business Technology Platform');
    expect(correct).toBeTruthy();
    await correct!.trigger('click');
    // Kasimir should show correct mood
    expect(w.find('.kasimir--correct').exists()).toBe(true);
    // advance to completion
    await w.find('[data-testid="ktt-next"]').trigger('click');
    // lesson has no more beats — should emit complete with lesson id
    // Allow a tick for any async work
    await new Promise(r => setTimeout(r, 0));
    expect(w.emitted('complete')).toBeTruthy();
    expect(w.emitted('complete')![0]).toEqual(['core-1']);
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
    // answer correctly
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
    await choices.find(c => c.text() === 'Business Technology Platform')!.trigger('click');
    // Should show XP
    expect(w.text()).toContain('10');
  });
});
