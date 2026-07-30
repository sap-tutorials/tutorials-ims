import { expect, test } from 'vitest';
import { buildToolRegistry } from '../../srv/lib/chat-orchestrator.js';

test('puzzleHint tool is registered only when puzzleHintEnabled', () => {
  const off = buildToolRegistry({ settings: {} });
  expect(off.some(t => t.function?.name === 'puzzleHint')).toBe(false);

  const on = buildToolRegistry({ settings: { puzzleHintEnabled: true } });
  expect(on.some(t => t.function?.name === 'puzzleHint')).toBe(true);
});

test('puzzle page gets a trimmed palette: searchTutorials + gated puzzleHint only', () => {
  const on = buildToolRegistry({
    settings: { puzzleHintEnabled: true, ragEnabled: true, branchingEnabled: true },
    pageContext: { kind: 'puzzle' },
  });
  const names = on.map(t => t.function?.name).sort();
  // Only searchTutorials + puzzleHint — the learner-only tools are suppressed
  // even though ragEnabled/branchingEnabled would otherwise register them.
  expect(names).toEqual(['puzzleHint', 'searchTutorials']);

  const off = buildToolRegistry({
    settings: { puzzleHintEnabled: false },
    pageContext: { kind: 'puzzle' },
  });
  expect(off.map(t => t.function?.name)).toEqual(['searchTutorials']);
});

