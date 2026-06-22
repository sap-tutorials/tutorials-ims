// test/unit/devtoberfest-status-handler.test.js
// Tests for GET /api/devtoberfest/status. Built incrementally across
// Tasks 3, 4. Each slice adds one branch of the state machine in
// spec §6.1.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('GET /api/devtoberfest/status', () => {
  let DevtoberfestConfig, Events;

  beforeAll(() => {
    ({ DevtoberfestConfig, Events } = cds.entities('com.sap.developers.ims'));
  });

  beforeEach(async () => {
    await DELETE.from(DevtoberfestConfig);
    await DELETE.from(Events);
  });

  it('returns 503 EVENT_NOT_CONFIGURED when currentEvent is NULL', async () => {
    const res = await project.axios.get('/api/devtoberfest/status', {
      validateStatus: () => true,
    });
    expect(res.status).toBe(503);
    expect(res.data.error).toBe('EVENT_NOT_CONFIGURED');
  });

  it('returns 503 idempotently across repeated calls (singleton race tolerance)', async () => {
    // Two sequential GETs must BOTH return 503 with the same body.
    // Verifies ensureDevtoberfestConfigSingleton's check-then-INSERT
    // doesn't break on the second call (where the row already exists).
    const r1 = await project.axios.get('/api/devtoberfest/status', {
      validateStatus: () => true,
    });
    const r2 = await project.axios.get('/api/devtoberfest/status', {
      validateStatus: () => true,
    });
    expect(r1.status).toBe(503);
    expect(r2.status).toBe(503);
    expect(r1.data.error).toBe('EVENT_NOT_CONFIGURED');
    expect(r2.data.error).toBe('EVENT_NOT_CONFIGURED');
  });
});
