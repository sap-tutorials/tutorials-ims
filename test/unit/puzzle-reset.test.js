// test/unit/puzzle-reset.test.js
//
// Unit tests for PuzzleService.resetPuzzleProgress action (Task 3, #1412 item 2).
// Bootstrap: cds.test() HTTP pattern — uses POST so the mocked-auth middleware
// enforces @requires:'authenticated-user' before the handler runs.

import { describe, it, expect } from 'vitest';
const cds = require('@sap/cds');

describe('PuzzleService.resetPuzzleProgress', () => {
  const { POST } = cds.test('serve', '--project', '.', '--in-memory');

  it('rejects anonymous callers with 401', async () => {
    await expect(
      POST('/puzzle-api/resetPuzzleProgress', { slug: 'devtoberfest-cryptic-crossword' })
    ).rejects.toMatchObject({ response: { status: 401 } });
  });
});
