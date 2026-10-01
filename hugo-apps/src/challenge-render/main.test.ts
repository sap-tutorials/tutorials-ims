// @vitest-environment happy-dom
// hugo-apps/src/challenge-render/main.test.ts
//
// RESEARCH SPIKE (#2362) — proves the challenge-render island entry:
// it reads the per-step `challenge` spec out of <script id="tutorial-data">,
// finds each `.step-challenge-mount` marker, and mounts the panel against the
// matching step. A step with no challenge (no marker) is a clean no-op.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const csrfFetch = vi.fn();
vi.mock('@shared/csrf-fetch', () => ({ csrfFetch: (...args: unknown[]) => csrfFetch(...args) }));

// #2558 — deterministic shuffle so we can assert the remapped answerIndex.
vi.mock('@shared/shuffle', () => ({
  shuffleArray: (arr: unknown[]) => [...arr].reverse(),
}));

function bakePage(steps: unknown, mountSteps: number[]) {
  const mounts = mountSteps
    .map((n) => `<div class="step-challenge-mount" data-step="${n}"></div>`)
    .join('');
  document.body.innerHTML =
    `<script id="tutorial-data" type="application/json">${JSON.stringify(steps)}</script>` +
    mounts;
}

async function runIsland() {
  vi.resetModules();
  await import('./main');
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-page-slug');
  csrfFetch.mockReset();
});

describe('challenge-render island', () => {
  it('mounts the panel for a step that carries a challenge spec', async () => {
    const steps = [
      {
        number: 1,
        challenge: {
          nodes: [
            { id: 'c-1', type: 'heading', text: 'Check yourself' },
            { id: 'c-2', type: 'mcq', prompt: 'Which?', options: ['a', 'b', 'c', 'd'], answerIndex: 0 },
          ],
        },
      },
    ];
    bakePage(steps, [1]);
    await runIsland();
    expect(document.querySelector('.challenge-panel')).not.toBeNull();
    expect(document.querySelector('.challenge-heading')?.textContent).toBe('Check yourself');
    expect(document.querySelectorAll('.challenge-option')).toHaveLength(4);
  });

  it('handles a double-encoded tutorial-data payload (Hugo jsonify-of-string)', async () => {
    // Hugo emits `.Params.steps | jsonify`, which for the baked page is a JSON
    // string — so the script body is JSON-of-a-JSON-string. main.ts double-parses.
    const steps = [{ number: 1, challenge: { nodes: [{ id: 'c-1', type: 'heading', text: 'Hi' }] } }];
    document.body.innerHTML =
      `<script id="tutorial-data" type="application/json">${JSON.stringify(JSON.stringify(steps))}</script>` +
      `<div class="step-challenge-mount" data-step="1"></div>`;
    await runIsland();
    expect(document.querySelector('.challenge-heading')?.textContent).toBe('Hi');
  });

  it('leaves a mount untouched when its step has no challenge', async () => {
    const steps = [{ number: 1 }, { number: 2, challenge: { nodes: [{ id: 'c-1', type: 'heading', text: 'Only step 2' }] } }];
    bakePage(steps, [1, 2]);
    await runIsland();
    const panels = document.querySelectorAll('.challenge-panel');
    expect(panels).toHaveLength(1);
    // step 1's mount stayed an empty div (island returned early for it)
    const step1Mount = document.querySelector('.step-challenge-mount[data-step="1"]');
    expect(step1Mount).not.toBeNull();
    expect(step1Mount?.children.length).toBe(0);
  });

  it('is a no-op when there is no tutorial-data script', async () => {
    document.body.innerHTML = `<div class="step-challenge-mount" data-step="1"></div>`;
    await runIsland();
    expect(document.querySelector('.challenge-panel')).toBeNull();
  });

  it('threads the page slug + step number into the grade POST (#2441)', async () => {
    csrfFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ verdict: 'pass', summary: 'ok' }) });
    document.documentElement.dataset.pageSlug = 'My-Tutorial';
    const steps = [{ number: 3, challenge: { nodes: [{ id: 'challenge-3-0', type: 'freeText', prompt: 'Explain.', aiGraded: true }] } }];
    bakePage(steps, [3]);
    await runIsland();

    const textarea = document.querySelector('.challenge-freetext textarea') as HTMLTextAreaElement;
    textarea.value = 'my answer';
    textarea.dispatchEvent(new Event('input'));
    (document.querySelector('.challenge-freetext .challenge-check') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));

    expect(csrfFetch).toHaveBeenCalledOnce();
    const [url, init] = csrfFetch.mock.calls[0];
    expect(url).toBe('/api/challenge-grade');
    expect(JSON.parse(init.body)).toEqual({
      tutorialSlug: 'my-tutorial', stepNumber: 3, nodeId: 'challenge-3-0', submittedAnswer: 'my answer',
    });
  });
});

describe('challenge island answer shuffle (#2558)', () => {
  it('shuffles mcq options and remaps answerIndex to the same option string', async () => {
    // correct option is 'a' at index 0; reverse → ['d','c','b','a'], so the
    // correct option 'a' is now at index 3.
    const steps = [
      {
        number: 1,
        challenge: {
          nodes: [
            { id: 'm1', type: 'mcq', prompt: 'Which?', options: ['a', 'b', 'c', 'd'], answerIndex: 0 },
          ],
        },
      },
    ];
    bakePage(steps, [1]);
    await runIsland();

    const labels = [...document.querySelectorAll('.challenge-option')].map(
      (l) => l.textContent?.trim(),
    );
    expect(labels).toEqual(['d', 'c', 'b', 'a']);

    // Grade by selecting the option now at the remapped correct index (3).
    const radios = document.querySelectorAll<HTMLInputElement>('.challenge-option input');
    radios[3].checked = true;
    radios[3].dispatchEvent(new Event('change', { bubbles: true }));
    (document.querySelector('.challenge-check') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));

    const verdict = document.querySelector('.challenge-verdict');
    expect(verdict?.getAttribute('data-status')).toBe('correct');
  });

  it('grades a non-correct index as incorrect after shuffle', async () => {
    const steps = [
      {
        number: 1,
        challenge: {
          nodes: [
            { id: 'm1', type: 'mcq', prompt: 'Which?', options: ['a', 'b', 'c', 'd'], answerIndex: 0 },
          ],
        },
      },
    ];
    bakePage(steps, [1]);
    await runIsland();

    const radios = document.querySelectorAll<HTMLInputElement>('.challenge-option input');
    radios[0].checked = true; // 'd' after reverse — not the correct answer
    radios[0].dispatchEvent(new Event('change', { bubbles: true }));
    (document.querySelector('.challenge-check') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));

    expect(document.querySelector('.challenge-verdict')?.getAttribute('data-status')).toBe('incorrect');
  });
});
