import { expect, test } from 'vitest';
import { buildToolRegistry } from '../../srv/lib/chat-orchestrator.js';

test('puzzleHint tool is registered only when puzzleHintEnabled', () => {
  const off = buildToolRegistry({ settings: {} });
  expect(off.some(t => t.function?.name === 'puzzleHint')).toBe(false);

  const on = buildToolRegistry({ settings: { puzzleHintEnabled: true } });
  expect(on.some(t => t.function?.name === 'puzzleHint')).toBe(true);
});
