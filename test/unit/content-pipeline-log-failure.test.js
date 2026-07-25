// test/unit/content-pipeline-log-failure.test.js
// Tests the CI rebuild-failure reporter endpoint handler
// (pipelineLogFailureHandler, POST /content/pipeline-log). It lets
// rebuild-content(-qa).yml `if: failure()` steps record a FAILED PipelineLog
// row for failures that happen in CI BEFORE content reaches the srv (Hugo
// build gate, verify-qa-build, auth 503) — so they surface in the admin
// PipelineLog dashboard instead of only as a red run in an unwatched CI tab.
//
// Asserts:
//   - a well-formed body writes a FAILED row with the given pipelineType,
//     initiator, summary, errorDetails, and 201 response.
//   - an invalid/unknown pipelineType defaults to HUGO_BUILD (enum-safe).

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { createContentHandlers } from '../../srv/lib/content-store.js';

const NS = 'com.sap.developers.ims';

cds.test('serve', '--project', '.', '--in-memory');

function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

describe('pipelineLogFailureHandler — CI rebuild-failure reporter', () => {
  let handler;
  let PipelineLog;

  beforeAll(() => {
    ({ pipelineLogFailureHandler: handler } = createContentHandlers({ namespace: NS }));
    ({ PipelineLog } = cds.entities(NS));
  });

  beforeEach(async () => {
    await DELETE.from(PipelineLog);
  });

  it('writes a FAILED row with the supplied fields and returns 201', async () => {
    const res = mockRes();
    await handler({
      body: {
        pipelineType: 'HUGO_BUILD',
        initiator: 'ci/rebuild-content@repository_dispatch',
        summary: 'rebuild-content failed (env=prod, mode=slug-targeted)',
        errorDetails: 'CI run failed before/at content publish. Logs: https://example/run/1',
        metadata: { env: 'prod', mode: 'slug-targeted' },
      },
    }, res);

    expect(res.statusCode).toBe(201);
    expect(res.body.status).toBe('FAILED');
    expect(res.body.pipelineType).toBe('HUGO_BUILD');

    const row = await SELECT.one.from(PipelineLog).where({ ID: res.body.id });
    expect(row, 'FAILED PipelineLog row should be persisted').toBeTruthy();
    expect(row.status).toBe('FAILED');
    expect(row.pipelineType).toBe('HUGO_BUILD');
    expect(row.initiator).toBe('ci/rebuild-content@repository_dispatch');
    expect(row.summary).toContain('rebuild-content failed');
    expect(row.errorDetails).toContain('https://example/run/1');
    expect(row.finishedAt, 'row should be closed (finishedAt set)').toBeTruthy();
  });

  it('defaults an unknown pipelineType to HUGO_BUILD (enum-safe)', async () => {
    const res = mockRes();
    await handler({ body: { pipelineType: 'NOT_A_REAL_TYPE', initiator: 'ci' } }, res);

    expect(res.statusCode).toBe(201);
    expect(res.body.pipelineType).toBe('HUGO_BUILD');
    const row = await SELECT.one.from(PipelineLog).where({ ID: res.body.id });
    expect(row.pipelineType).toBe('HUGO_BUILD');
    expect(row.status).toBe('FAILED');
  });
});
