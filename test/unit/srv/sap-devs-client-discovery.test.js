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

  it('validator throws when a mission row is missing description (non-string)', async () => {
    // `description` is optional-value but must be a string. Undefined is
    // a wire-shape regression, not a curation gap.
    _setMockTransport({
      async call() {
        return {
          results: [{ id: '999', name: 'No desc', effort: '1', category: 'onboard' }],
        };
      },
    });
    await expect(sapDevsClient.searchDiscovery({ type: 'missions' })).rejects.toThrow(/description/);
  });

  it('validator ACCEPTS empty effort (rows for new missions with no estimate)', async () => {
    // Discovery Center returns Effort: "" for missions that don't have
    // an estimated hour count yet. The fetcher's downstream code
    // (fetch-discovery-missions-job.js:146-147) parses empty to null
    // and writes it to a nullable column — the validator must let those
    // rows through. Regression from PR #851 where empty effort blocked
    // the whole fetcher cycle.
    _setMockTransport({
      async call() {
        return {
          results: [
            { id: '4064', name: 'Multitenant CAP', effort: '', category: 'appdev', description: 'Long desc' },
          ],
        };
      },
    });
    const rows = await sapDevsClient.searchDiscovery({ type: 'missions' });
    expect(rows).toHaveLength(1);
    expect(rows[0].effort).toBe('');
  });

  it('validator ACCEPTS empty description (missions with only a title)', async () => {
    _setMockTransport({
      async call() {
        return {
          results: [
            { id: '4064', name: 'Some Mission', effort: '2', category: 'appdev', description: '' },
          ],
        };
      },
    });
    const rows = await sapDevsClient.searchDiscovery({ type: 'missions' });
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toBe('');
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
