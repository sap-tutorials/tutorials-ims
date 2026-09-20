// test/unit/challenge-grade-question-loader.test.js
// Unit tests for srv/lib/challenge-grade-question-loader.js (#2441).
// Two-step lookup Tutorials.slug → tutorial_ID → ChallengeAnswers by key.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { defaultLoadChallengeAnswer } from '../../srv/lib/challenge-grade-question-loader.js';

beforeAll(async () => {
  await cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:');
});

beforeEach(async () => {
  const { ChallengeAnswers, Tutorials } = cds.entities('com.sap.developers.ims');
  await DELETE.from(ChallengeAnswers);
  await DELETE.from(Tutorials);
  await INSERT.into(Tutorials).entries([
    { ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', slug: 'tutorial-alpha', title: 'Alpha', status: 'ACTIVE' },
  ]);
  await INSERT.into(ChallengeAnswers).entries([
    { tutorial_ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', stepNumber: 2, nodeId: 'challenge-2-0', prompt: 'Q?', reference: 'The answer.' },
  ]);
});

describe('defaultLoadChallengeAnswer', () => {
  it('hit → dispatch-shaped object', async () => {
    const r = await defaultLoadChallengeAnswer('tutorial-alpha', 2, 'challenge-2-0');
    expect(r).toEqual({ nodeId: 'challenge-2-0', prompt: 'Q?', reference: 'The answer.' });
  });

  it('slug lowercased on lookup', async () => {
    const r = await defaultLoadChallengeAnswer('Tutorial-ALPHA', 2, 'challenge-2-0');
    expect(r?.reference).toBe('The answer.');
  });

  it('unknown slug → null', async () => {
    expect(await defaultLoadChallengeAnswer('nope', 2, 'challenge-2-0')).toBe(null);
  });

  it('unknown nodeId → null', async () => {
    expect(await defaultLoadChallengeAnswer('tutorial-alpha', 2, 'challenge-9-9')).toBe(null);
  });

  it('empty slug → null', async () => {
    expect(await defaultLoadChallengeAnswer('', 2, 'challenge-2-0')).toBe(null);
  });
});
