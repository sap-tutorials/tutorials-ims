import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  sapDevsClient,
  _setMockTransport,
  _resetCache,
} from '../../../srv/lib/sap-devs-client.js';

const FIXTURE = JSON.parse(
  readFileSync(join(import.meta.dirname, '__fixtures__/sap-devs-discovery-search.json'), 'utf8'),
);

describe('sap-devs-client.searchDiscovery', () => {
  beforeEach(() => {
    _setMockTransport(null);
    _resetCache();
  });

  afterEach(() => {
    _resetCache();
  });

  it('returns missions array from a one-shot MCP response', async () => {
    _setMockTransport({
      async call(toolName, args) {
        expect(toolName).toBe('search_discovery');
        expect(args?.type).toBe('missions');
        // Envelope shape: { results: [...] } per searchLearningJourneys precedent.
        // callCached strips the envelope; method returns the raw rows array.
        return { results: FIXTURE.missions };
      },
    });

    const missions = await sapDevsClient.searchDiscovery({ type: 'missions', limit: 50 });
    expect(missions).toHaveLength(3);
    expect(missions[0].id).toBe('3019');
    expect(missions[0].name).toBe('Get Started with SAP BTP Enterprise Account');
  });

  it('throws when type=trials (deferred to a future sub-phase)', async () => {
    await expect(
      sapDevsClient.searchDiscovery({ type: 'trials' }),
    ).rejects.toThrow(/trials.*deferred|not supported in Phase 4\.3/i);
  });

  it('validator throws when a mission row is missing id', async () => {
    _setMockTransport({
      async call() {
        return {
          results: [{ name: 'Headless', effort: '1', category: 'onboard', description: 'x' }],
        };
      },
    });
    await expect(sapDevsClient.searchDiscovery({ type: 'missions' })).rejects.toThrow(/id/);
  });

  it('validator throws when a mission row is missing description', async () => {
    _setMockTransport({
      async call() {
        return {
          results: [{ id: '999', name: 'No desc', effort: '1', category: 'onboard' }],
        };
      },
    });
    await expect(sapDevsClient.searchDiscovery({ type: 'missions' })).rejects.toThrow(/description/);
  });

  it('caches successive calls with the same params', async () => {
    let callCount = 0;
    _setMockTransport({
      async call() {
        callCount++;
        return { results: FIXTURE.missions };
      },
    });

    await sapDevsClient.searchDiscovery({ type: 'missions', limit: 50 });
    await sapDevsClient.searchDiscovery({ type: 'missions', limit: 50 });
    expect(callCount).toBe(1);
  });
});
