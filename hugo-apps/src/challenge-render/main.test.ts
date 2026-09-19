// @vitest-environment happy-dom
// hugo-apps/src/challenge-render/main.test.ts
//
// RESEARCH SPIKE (#2362) — proves the challenge-render island entry:
// it reads the per-step `challenge` spec out of <script id="tutorial-data">,
// finds each `.step-challenge-mount` marker, and mounts the panel against the
// matching step. A step with no challenge (no marker) is a clean no-op.
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
});
