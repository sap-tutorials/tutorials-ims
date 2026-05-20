import { describe, it, expect } from 'vitest';
import { BASE_URL, fetchWithRetry, authHeader } from './smoke.config.js';

describe('admin Joule smoke', () => {
  it('rejects unauthenticated POST to /chat/stream with admin pageContext', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hi' }],
        pageContext: { kind: 'admin' }
      }),
    });
    expect([302, 401, 403]).toContain(res.status);
  });

  const auth = authHeader();
  const maybe = auth ? it : it.skip;
  maybe('authenticated SSE response never leaks user-identifying fields', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hi' }],
        pageContext: { kind: 'admin' }
      }),
    });
    const text = await res.text();
    const lower = text.toLowerCase();
    for (const banned of ['user_id', '"email"', '"givenname"', '"familyname"', 'accountnumber']) {
      expect(lower).not.toContain(banned);
    }
  });
});
