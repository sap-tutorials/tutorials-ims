// test/unit/ktt-banter.test.js
// Unit tests for computeBanter — fail-open Kasimir banter helper.
// Pure ESM, no cds.test bootstrap needed (no DB interaction).

import { expect, test, vi } from 'vitest';
import { computeBanter } from '../../srv/lib/ktt/banter.js';

test('banter returns a fallback line when AICore fails', async () => {
  const brokenAi = { chat: vi.fn(async () => { throw new Error('AICore down'); }) };
  const line = await computeBanter(brokenAi, { event: 'streak', streak: 5 });
  expect(typeof line).toBe('string');
  expect(line.length).toBeGreaterThan(0);
});

test('banter returns trimmed AI response when chat resolves', async () => {
  const goodAi = { chat: vi.fn(async () => '  Nice one!  ') };
  const line = await computeBanter(goodAi, { event: 'correct' });
  expect(line).toBe('Nice one!');
  expect(line.length).toBeLessThanOrEqual(160);
});

test('banter returns wrong fallback when ai is null', async () => {
  const line = await computeBanter(null, { event: 'wrong' });
  expect(line).toBe('A miss! Even I cough up the occasional hairball. Try again.');
});
