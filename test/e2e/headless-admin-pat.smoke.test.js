import { describe, it, expect } from 'vitest';

const base = process.env.SMOKE_BASE_URL;
const pat = process.env.SMOKE_ADMIN_PAT;

describe.skipIf(!base || !pat)('headless admin PAT (deployed)', () => {
  it('GET /admin-pat/Tutorials?$top=1 returns 200', async () => {
    const res = await fetch(`${base}/admin-pat/Tutorials?$top=1`, {
      headers: { Authorization: `Bearer ${pat}` },
    });
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
    expect(res.status).toBe(200);
  });

  it('POST /graphql-pat returns 200', async () => {
    const res = await fetch(`${base}/graphql-pat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pat}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: '{ __typename }' }),
    });
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
    expect(res.status).toBe(200);
  });
});
