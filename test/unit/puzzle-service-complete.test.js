// test/unit/puzzle-service-complete.test.js
//
// Unit tests for PuzzleService saveProgress / getProgress / complete (Task 6).
// Bootstrap: cds.test() pattern matching other unit tests in this project.

import { expect, test, beforeAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

let svc, pid;
const FAKE_USER = { id: 'u-sap-1', attr: {} };

beforeAll(async () => {
  const { Puzzles, Users } = cds.entities('com.sap.developers.ims');
  await INSERT.into(Users).entries({ ID: cds.utils.uuid(), uuid: 'u-sap-1', sapId: 'u-sap-1' });
  pid = cds.utils.uuid();
  await INSERT.into(Puzzles).entries({
    ID: pid, title: 'Done', slug: 'done', legacyId: 9001,
    layout: JSON.stringify({ rows: 1, cols: 3, grid: [[{ black: false }, { black: false }, { black: false }]], clues: { '0-0-across': 'x' } }),
    solution: JSON.stringify({ '0,0': 'C', '0,1': 'A', '0,2': 'T' })
  });
  svc = await cds.connect.to('PuzzleService');
});

test('saveProgress then getProgress round-trips the grid', async () => {
  await svc.tx({ user: new cds.User(FAKE_USER) }, tx => tx.send('saveProgress', { slug: 'done', filledGrid: '{"0,0":"C"}' }));
  const g = await svc.tx({ user: new cds.User(FAKE_USER) }, tx => tx.send('getProgress', { slug: 'done' }));
  expect(g.filledGrid).toBe('{"0,0":"C"}');
});

test('complete writes a PUZZLE TaskRecord once (idempotent)', async () => {
  await svc.tx({ user: new cds.User(FAKE_USER) }, tx => tx.send('saveProgress', { slug: 'done', filledGrid: '{"0,0":"C","0,1":"A","0,2":"T"}' }));
  const first = await svc.tx({ user: new cds.User(FAKE_USER) }, tx => tx.send('complete', { slug: 'done' }));
  expect(first.recorded).toBe(true);
  const second = await svc.tx({ user: new cds.User(FAKE_USER) }, tx => tx.send('complete', { slug: 'done' }));
  expect(second.alreadyComplete).toBe(true);
  const { TaskRecords } = cds.entities('com.sap.developers.ims');
  const recs = await SELECT.from(TaskRecords).where({ taskLegacyId: 9001, taskType: 'PUZZLE' });
  expect(recs.length).toBe(1);
});
