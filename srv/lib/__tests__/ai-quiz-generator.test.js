import { describe, it, expect, vi } from 'vitest';
import { generateQuiz, PROMPT_VERSION } from '../ai-quiz-generator.js';

const MODEL_RESP = (questions) => ({
  toolCalls: [{
    name: 'submitQuiz',
    arguments: JSON.stringify({ questions }),
  }],
  modelName: 'gpt-test',
  promptTokens: 100,
  completionTokens: 200,
  finishReason: 'tool_call',
});

describe('generateQuiz (#208)', () => {
  it('happy MCQ + text mix returns valid ValidationQuestion[]', async () => {
    const callModel = vi.fn().mockResolvedValue(MODEL_RESP([
      { type: 'multiple-choice', question: 'Pick one', options: ['A', 'B', 'C', 'D'], correctAnswer: 'B' },
      { type: 'text', question: 'Explain X', correctAnswer: 'X is the thing that does Y.' },
    ]));
    const out = await generateQuiz({
      stepBody: 'A short tutorial step about thingies.',
      stepNumber: 3,
      slug: 'sample',
      types: 'mcq-and-text',
      deps: { callModel },
    });
    expect(out.errorReason).toBeUndefined();
    expect(out.questions).toHaveLength(2);
    expect(out.questions[0]).toMatchObject({
      id: 'validate-3-ai-1',
      type: 'multiple-choice',
      options: ['A', 'B', 'C', 'D'],
      correctAnswer: 'B',
      aiAuthored: true,
    });
    expect(out.questions[1]).toMatchObject({
      id: 'validate-3-ai-2',
      type: 'text',
      aiGrading: true,
      aiAuthored: true,
    });
    // Anti-leak: text question's correctAnswer NOT in public emit.
    expect(out.questions[1].correctAnswer).toBeUndefined();
    // Telemetry preserved.
    expect(out.modelName).toBe('gpt-test');
    expect(out.promptVersion).toBe(PROMPT_VERSION);
  });

  it('MCQ correctAnswer not in options → empty + errorReason', async () => {
    const callModel = vi.fn().mockResolvedValue(MODEL_RESP([
      { type: 'multiple-choice', question: 'Pick one', options: ['A', 'B', 'C', 'D'], correctAnswer: 'Z' },
    ]));
    const out = await generateQuiz({
      stepBody: 'x', stepNumber: 1, slug: 's', types: 'mcq-only', deps: { callModel },
    });
    expect(out.questions).toEqual([]);
    expect(out.errorReason).toBe('mcq_correct_not_in_options');
  });

  it('question text contains literal correctAnswer → empty + errorReason: leak_detected', async () => {
    const callModel = vi.fn().mockResolvedValue(MODEL_RESP([
      // The correctAnswer text appears verbatim inside the question.
      { type: 'text', question: 'What is "Apache Kafka"?', correctAnswer: 'Apache Kafka' },
    ]));
    const out = await generateQuiz({
      stepBody: 'x', stepNumber: 1, slug: 's', types: 'text-only', deps: { callModel },
    });
    expect(out.questions).toEqual([]);
    expect(out.errorReason).toBe('leak_detected');
  });

  it('callModel throws → empty + errorReason: upstream', async () => {
    const callModel = vi.fn().mockRejectedValue(new Error('network blip'));
    const out = await generateQuiz({
      stepBody: 'x', stepNumber: 1, slug: 's', types: 'mcq-only', deps: { callModel },
    });
    expect(out.questions).toEqual([]);
    expect(out.errorReason).toBe('upstream');
  });

  it('schema validation failure → empty + errorReason: schema', async () => {
    // No `questions` array on the response.
    const callModel = vi.fn().mockResolvedValue({
      toolCalls: [{ name: 'submitQuiz', arguments: JSON.stringify({ wrong: 'shape' }) }],
      modelName: 'gpt-test', promptTokens: 1, completionTokens: 1,
    });
    const out = await generateQuiz({
      stepBody: 'x', stepNumber: 1, slug: 's', types: 'mcq-only', deps: { callModel },
    });
    expect(out.questions).toEqual([]);
    expect(out.errorReason).toBe('schema');
  });

  it("types: 'mcq-only' includes 'multiple-choice' only in user message", async () => {
    const callModel = vi.fn().mockResolvedValue(MODEL_RESP([
      { type: 'multiple-choice', question: 'Q', options: ['a', 'b', 'c', 'd'], correctAnswer: 'a' },
    ]));
    await generateQuiz({
      stepBody: 'body', stepNumber: 1, slug: 's', types: 'mcq-only', deps: { callModel },
    });
    const userMsg = callModel.mock.calls[0][0].messages.find(m => m.role === 'user').content;
    expect(userMsg).toContain('multiple-choice');
    expect(userMsg).not.toContain('free-text');
  });

  it("types: 'text-only' includes 'free-text' only in user message", async () => {
    const callModel = vi.fn().mockResolvedValue(MODEL_RESP([
      { type: 'text', question: 'Q', correctAnswer: 'A' },
    ]));
    await generateQuiz({
      stepBody: 'body', stepNumber: 1, slug: 's', types: 'text-only', deps: { callModel },
    });
    const userMsg = callModel.mock.calls[0][0].messages.find(m => m.role === 'user').content;
    expect(userMsg).toContain('free-text');
    expect(userMsg).not.toContain('multiple-choice');
  });

  it('aiAuthored: true set on every emitted question', async () => {
    const callModel = vi.fn().mockResolvedValue(MODEL_RESP([
      { type: 'multiple-choice', question: 'Q', options: ['a', 'b', 'c', 'd'], correctAnswer: 'a' },
      { type: 'text', question: 'Q2', correctAnswer: 'A2' },
    ]));
    const out = await generateQuiz({
      stepBody: 'x', stepNumber: 1, slug: 's', types: 'mcq-and-text', deps: { callModel },
    });
    expect(out.questions.every(q => q.aiAuthored === true)).toBe(true);
  });

  it("text question's emit omits correctAnswer and sets aiGrading: true", async () => {
    const callModel = vi.fn().mockResolvedValue(MODEL_RESP([
      { type: 'text', question: 'Explain', correctAnswer: 'because reasons' },
    ]));
    const out = await generateQuiz({
      stepBody: 'x', stepNumber: 1, slug: 's', types: 'text-only', deps: { callModel },
    });
    expect(out.questions[0].correctAnswer).toBeUndefined();
    expect(out.questions[0].aiGrading).toBe(true);
  });

  it("MCQ's emit retains correctAnswer and does NOT set aiGrading", async () => {
    const callModel = vi.fn().mockResolvedValue(MODEL_RESP([
      { type: 'multiple-choice', question: 'Q', options: ['a', 'b', 'c', 'd'], correctAnswer: 'a' },
    ]));
    const out = await generateQuiz({
      stepBody: 'x', stepNumber: 1, slug: 's', types: 'mcq-only', deps: { callModel },
    });
    expect(out.questions[0].correctAnswer).toBe('a');
    expect(out.questions[0].aiGrading).toBeUndefined();
  });
});
