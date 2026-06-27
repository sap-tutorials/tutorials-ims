import { describe, it, expect } from 'vitest';
import { shapeAdvocateRow } from '../../../srv/routes/advocates-public.js';

describe('shapeAdvocateRow', () => {
  const ctx = {
    topicsByAdv: new Map([['A1', [{ slug: 'cap', label: 'CAP' }]]]),
    linksByAdv: new Map([['A1', [{ kind: 'LinkedIn', url: 'https://x', label: null, sortOrder: 100 }]]]),
    userById: new Map([['U1', { ID: 'U1', email: 't@example.com' }]]),
    authoredByUserId: new Map([['U1', [{ slug: 't1', title: 'Tut 1' }]]]),
    contribByUserId: new Map([['U1', [{ slug: 't2', title: 'Tut 2' }]]]),
  };

  it('emits the canonical row shape', () => {
    const row = shapeAdvocateRow({
      ID: 'A1', slug: 'a-one', firstName: 'A', lastName: 'One',
      title: 'Advocate', region: 'AMERICAS',
      bio: 'hi', hasPhoto: true, photoUpdatedAt: '2026-06-27',
      user_ID: 'U1',
    }, ctx);
    expect(row.slug).toBe('a-one');
    expect(row.topics).toEqual([{ slug: 'cap', label: 'CAP' }]);
    expect(row.links).toHaveLength(1);
    expect(row.email).toBe('t@example.com');
    expect(row.authoredTutorials).toEqual([{ slug: 't1', title: 'Tut 1' }]);
    expect(row.contributedTutorials).toEqual([{ slug: 't2', title: 'Tut 2' }]);
  });

  it('omits email/authored/contributed when unlinked', () => {
    const row = shapeAdvocateRow({
      ID: 'A2', slug: 'a-two', firstName: 'A', lastName: 'Two',
      region: 'EMEA', user_ID: null,
    }, ctx);
    expect(row).not.toHaveProperty('email');
    expect(row).not.toHaveProperty('authoredTutorials');
    expect(row).not.toHaveProperty('contributedTutorials');
  });
});
