import { expect, test, beforeAll } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';

const schemaPath = path.join(process.cwd(), 'db', 'schema.cds');

beforeAll(async () => { await cds.deploy(schemaPath).to('sqlite::memory:'); });

test('Puzzles round-trips slug/layout/solution', async () => {
  const { Puzzles } = cds.entities('com.sap.developers.ims');
  await INSERT.into(Puzzles).entries({ ID: cds.utils.uuid(), title: 'T', slug: 'p1',
    layout: '{"rows":3,"cols":3}', solution: '{"0,0":"A"}' });
  const row = await SELECT.one.from(Puzzles).where({ slug: 'p1' });
  expect(row.layout).toBe('{"rows":3,"cols":3}');
  expect(row.solution).toBe('{"0,0":"A"}');
});

test('PuzzleProgress stores a per-user partial grid', async () => {
  const { Puzzles, PuzzleProgress, Users } = cds.entities('com.sap.developers.ims');
  const uid = cds.utils.uuid(), pid = cds.utils.uuid();
  await INSERT.into(Users).entries({ ID: uid, uuid: 'u1' });
  await INSERT.into(Puzzles).entries({ ID: pid, title: 'T2', slug: 'p2' });
  await INSERT.into(PuzzleProgress).entries({ ID: cds.utils.uuid(), user_ID: uid, puzzle_ID: pid,
    filledGrid: '{"0,0":"X"}', attemptNumber: 1 });
  const row = await SELECT.one.from(PuzzleProgress).where({ user_ID: uid, puzzle_ID: pid });
  expect(row.filledGrid).toBe('{"0,0":"X"}');
});
