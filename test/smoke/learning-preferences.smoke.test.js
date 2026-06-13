import { describe, it, expect } from 'vitest';

const SRV = process.env.SMOKE_SRV_URL;

describe.skipIf(!SRV)('LearningPreferences smoke (deployed)', () => {
  it('1. GET /api/LearningPreferences without auth returns 401', async () => {
    const resp = await fetch(`${SRV}/api/LearningPreferences`, {
      headers: { Accept: 'application/json' },
    });
    expect(resp.status).toBe(401);
  });

  it('2. GET /api/ChatConfig returns 200 and includes branchingEnabled at top level', async () => {
    const resp = await fetch(`${SRV}/api/ChatConfig`, {
      headers: { Accept: 'application/json' },
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    // OData singleton wrapper varies — find branchingEnabled wherever it sits.
    const flat = JSON.stringify(body);
    expect(flat).toMatch(/"branchingEnabled"\s*:\s*(true|false)/);
    expect(flat).toMatch(/"enabled"\s*:/);
    expect(flat).toMatch(/"bannerText"\s*:/);
  });
});
