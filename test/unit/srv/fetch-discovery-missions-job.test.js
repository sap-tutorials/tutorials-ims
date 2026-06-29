// test/unit/srv/fetch-discovery-missions-job.test.js
//
// #447 Phase 4.3 PR-2: end-to-end cron orchestration test.
// In-memory SQLite + mocked MCP + mocked LLM + mocked embed.

import { describe, it, beforeAll, afterAll, beforeEach, expect, vi } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';

let runFetchDiscoveryMissions;
let _setMockTransport;
let _resetCache;

function vec(...nums) { return new Float32Array(nums); }
function buf(...nums) {
  const f = vec(...nums);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

describe('fetch-discovery-missions-job — merge-on-write (#707) + crash-safety (#708)', () => {
  beforeAll(async () => {
    await cds.deploy([
      path.join(process.cwd(), 'db'),
      path.join(process.cwd(), 'srv'),
    ]).to('sqlite::memory:');

    ({ runFetchDiscoveryMissions } = await import('../../../srv/jobs/fetch-discovery-missions-job.js'));
    ({ _setMockTransport, _resetCache } = await import('../../../srv/lib/sap-devs-client.js'));
  });

  afterAll(async () => {
    await cds.disconnect();
  });

  beforeEach(async () => {
    const { Concepts } = cds.entities('com.sap.developers.ims');
    const { DiscoveryMissions, DiscoveryMissionConceptLinks, DiscoveryMissionServices } =
      cds.entities('com.sap.developers.ims.external');
    await DELETE.from(DiscoveryMissionConceptLinks);
    await DELETE.from(DiscoveryMissionServices);
    await DELETE.from(DiscoveryMissions);
    await DELETE.from(Concepts);

    const now = new Date().toISOString();
    await INSERT.into(Concepts).entries({
      slug: 'cap-handlers',
      name: 'CAP handlers',
      description: 'desc',
      embedding: buf(1, 0, 0, 0),
      status: 'ACTIVE',
      publishedAt: now,
      publishedBy: 'admin@sap.com',
    });

    _setMockTransport(null);
    _resetCache();
  });

  it('upserts the full catalog (NOT budget-gated) and processes within budget', async () => {
    // Mock MCP returns 3 missions.
    _setMockTransport({
      async call(toolName, args) {
        if (toolName === 'search_discovery') {
          return {
            results: [
              { id: '3019', name: 'Mission A', effort: '2', category: 'onboard',
                description: 'A mission description.' },
              { id: '3258', name: 'Mission B', effort: '1', category: 'develop',
                description: 'B mission description.' },
              { id: '3585', name: 'Mission C', effort: '3', category: 'iot',
                description: 'C mission description.' },
            ],
          };
        }
        throw new Error(`unmocked: ${toolName}`);
      },
    });

    const extractFn = vi.fn().mockResolvedValue({
      teaches: [{ slug: 'cap-handlers', name: 'CAP handlers', confidence: 0.9 }],
      usesServices: [{ name: 'SAP Integration Suite', confidence: 0.85 }],
      tokenUsage: { prompt: 100, completion: 50 },
    });
    const embed = vi.fn();

    // budget=2: only 2 of 3 missions extracted; ALL 3 upserted (upsert is NOT
    // budget-gated per spec).
    const summary = await runFetchDiscoveryMissions({
      embed, extractFn, budgetOverride: 2,
    });

    expect(summary.fetched).toBe(3);
    expect(summary.upserted).toBe(3);     // ALL 3 upserted regardless of budget
    expect(summary.extracted).toBe(2);    // only 2 extracted (budget=2)
    expect(summary.teachesWritten).toBe(2);
    expect(summary.servicesWritten).toBe(2);
    expect(summary.budgetExhausted).toBe(true);
  });

  it('merges + mints novel concepts via #707, dedups by conceptId for teaches', async () => {
    _setMockTransport({
      async call() {
        return {
          results: [
            { id: '3019', name: 'Test Mission', effort: '2', category: 'onboard',
              description: 'Test description.' },
          ],
        };
      },
    });

    const extractFn = vi.fn().mockResolvedValue({
      teaches: [
        { slug: 'cap-handlers', name: 'CAP handlers', confidence: 0.9 },          // exact
        { slug: 'cap-event-handlers', name: 'CAP event handlers', confidence: 0.85 }, // near-dup → merged
        { slug: 'odata-v4', name: 'OData v4', confidence: 0.8 },                    // novel mint
      ],
      usesServices: [],
      tokenUsage: { prompt: 100, completion: 50 },
    });

    const embed = vi.fn(async ([name]) => {
      if (name === 'CAP event handlers') return [vec(0.99, 0.01, 0, 0)];
      if (name === 'OData v4') return [vec(0, 0, 1, 0)];
      throw new Error(`unexpected embed: ${name}`);
    });

    const summary = await runFetchDiscoveryMissions({ embed, extractFn });

    expect(summary.mergedAtExtract).toBe(1);
    expect(summary.mintedAtExtract).toBe(1);
    // dedup: cap-handlers (exact) + cap-event-handlers (merged → cap-handlers) collapse
    expect(summary.teachesWritten).toBe(2);
  });

  it('dedups usesServices by serviceName.toLowerCase() case-insensitive', async () => {
    _setMockTransport({
      async call() {
        return {
          results: [
            { id: '3019', name: 'Test', effort: '2', category: 'onboard',
              description: 'd' },
          ],
        };
      },
    });

    const extractFn = vi.fn().mockResolvedValue({
      teaches: [],
      usesServices: [
        { name: 'SAP Integration Suite', confidence: 0.9 },
        { name: 'sap integration suite', confidence: 0.85 },  // case-different dup
        { name: 'SAP Build Apps', confidence: 0.8 },
      ],
      tokenUsage: { prompt: 100, completion: 50 },
    });
    const embed = vi.fn();

    const summary = await runFetchDiscoveryMissions({ embed, extractFn });
    expect(summary.servicesWritten).toBe(2);  // dedup collapsed 3 → 2
  });

  it('skips re-extraction when lastExtractedHash matches contentHash', async () => {
    _setMockTransport({
      async call() {
        return {
          results: [{
            id: '3019', name: 'Stable Mission', effort: '2', category: 'onboard',
            description: 'Unchanged description.',
          }],
        };
      },
    });

    const extractFn = vi.fn().mockResolvedValue({
      teaches: [{ slug: 'cap-handlers', name: 'CAP handlers', confidence: 0.9 }],
      usesServices: [],
      tokenUsage: { prompt: 100, completion: 50 },
    });
    const embed = vi.fn();

    await runFetchDiscoveryMissions({ embed, extractFn });
    _resetCache();
    const summary2 = await runFetchDiscoveryMissions({ embed, extractFn });
    expect(summary2.skippedNoChange).toBeGreaterThanOrEqual(1);
  });

  it('synthesises url from mcpId when MCP omits it', async () => {
    _setMockTransport({
      async call() {
        return {
          results: [{
            id: '3019', name: 'No URL Mission', effort: '2', category: 'onboard',
            description: 'd',
          }],
        };
      },
    });

    const extractFn = vi.fn().mockResolvedValue({
      teaches: [{ slug: 'cap-handlers', name: 'CAP handlers', confidence: 0.9 }],
      usesServices: [],
      tokenUsage: { prompt: 100, completion: 50 },
    });
    const embed = vi.fn();

    await runFetchDiscoveryMissions({ embed, extractFn });

    const { DiscoveryMissions } = cds.entities('com.sap.developers.ims.external');
    const row = await SELECT.one.from(DiscoveryMissions)
      .columns('url')
      .where({ slug: 'dm-3019' });
    expect(row.url).toBe('https://discovery-center.cloud.sap/missiondetail/3019/');
  });
});
