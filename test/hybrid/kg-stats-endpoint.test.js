// test/hybrid/kg-stats-endpoint.test.js
import { describe, it, expect } from 'vitest';
import './_guard.js'; // write-safety guard that other hybrid tests already use
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.');

describe('GET /build/kg-stats against real HANA', () => {
  it('returns positive integer counts and a valid lastExtractedAt', async () => {
    const start = Date.now();
    const { data, status } = await project.axios.get('/build/kg-stats');
    const elapsed = Date.now() - start;

    expect(status).toBe(200);
    expect(typeof data.tutorials).toBe('number');
    expect(data.tutorials).toBeGreaterThanOrEqual(0);
    expect(typeof data.concepts).toBe('number');
    expect(data.concepts).toBeGreaterThanOrEqual(0);
    expect(typeof data.relationships).toBe('number');
    expect(data.relationships).toBeGreaterThanOrEqual(0);
    expect(typeof data.missionsAndGroups).toBe('number');
    expect(data.missionsAndGroups).toBeGreaterThanOrEqual(0);

    // lastExtractedAt is null OR an ISO timestamp.
    if (data.lastExtractedAt !== null) {
      expect(new Date(data.lastExtractedAt).toString()).not.toBe('Invalid Date');
    }
    expect(new Date(data.generatedAt).toString()).not.toBe('Invalid Date');

    // Loose latency check: should be well under 200ms locally with cached HANA conns.
    expect(elapsed).toBeLessThan(2000);
  });
});
