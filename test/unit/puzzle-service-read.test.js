import { expect, test, beforeAll } from 'vitest';
import cds from '@sap/cds';

// House pattern: cds.test at module level, beforeAll connects to service.
cds.test('serve', '--project', '.', '--in-memory');

let PuzzleService;

beforeAll(async () => {
  const db = await cds.connect.to('db');
  const { Puzzles } = cds.entities('com.sap.developers.ims');
  await db.run(
    INSERT.into(Puzzles).entries({
      ID: cds.utils.uuid(),
      title: 'Sample',
      slug: 'sample-puzzle',
      layout: '{"rows":1,"cols":1,"grid":[[{"black":false}]]}',
      solution: '{"0,0":"A"}'
    })
  );
  PuzzleService = await cds.connect.to('PuzzleService');
});

test('public Puzzles projection exposes layout but NEVER solution', async () => {
  const rows = await PuzzleService.read('Puzzles');
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) {
    expect(r.layout).toBeTruthy();
    expect('solution' in r).toBe(false);
  }
});
