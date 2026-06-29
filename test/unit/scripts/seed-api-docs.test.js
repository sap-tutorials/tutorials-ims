// test/unit/scripts/seed-api-docs.test.js
//
// Phase 4.5 (#746) Task 1: unit tests for the api-docs seed module.
// Tests live under test/unit/scripts/ for consistency with sibling CLI
// tests, but the imported logic is the ESM module at srv/lib/seed-api-docs.js.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { runSeedApiDocs } from '../../../srv/lib/seed-api-docs.js';

// Boot CAP in-process against in-memory SQLite. cds.test() auto-deploys
// db/schema.cds + db/external-content.cds before any test runs.
cds.test('serve', '--project', '.', '--in-memory');

describe('seed-api-docs', () => {
  let ApiDocs;

  beforeAll(async () => {
    await cds.connect.to('db');
    ApiDocs = cds.entities('com.sap.developers.ims.external').ApiDocs;
  });

  beforeEach(async () => {
    // Clean slate per test — cds.test() shares the in-memory SQLite across
    // the file, so we wipe ApiDocs between cases for deterministic asserts.
    await DELETE.from(ApiDocs);
  });

  it('dry-run reports planned upserts without writing', async () => {
    const yamlContent = `
- sourceId: TEST_ONE
  title: Test One
  url: https://api.sap.com/test/one
  description: This is a test entry for the dry-run path.
  category: Test
  apiType: rest
`;
    const result = await runSeedApiDocs({ yamlContent, commit: false });
    expect(result.planned).toBe(1);
    expect(result.committed).toBe(0);
    const rows = await SELECT.from(ApiDocs);
    expect(rows).toHaveLength(0);
  });

  it('--commit upserts new rows', async () => {
    const yamlContent = `
- sourceId: TEST_ONE
  title: Test One
  url: https://api.sap.com/test/one
  description: This is a test entry for the commit path.
  category: Test
  apiType: rest
`;
    const result = await runSeedApiDocs({ yamlContent, commit: true });
    expect(result.committed).toBe(1);
    const rows = await SELECT.from(ApiDocs);
    expect(rows).toHaveLength(1);
    expect(rows[0].slug).toBe('ad-test_one');
  });

  it('re-running with unchanged YAML is idempotent (zero writes)', async () => {
    const yamlContent = `
- sourceId: TEST_ONE
  title: Test One
  url: https://api.sap.com/test/one
  description: This is a test entry for idempotency check.
  category: Test
  apiType: rest
`;
    const first = await runSeedApiDocs({ yamlContent, commit: true });
    expect(first.committed).toBe(1);

    const second = await runSeedApiDocs({ yamlContent, commit: true });
    expect(second.committed).toBe(0);    // contentHash unchanged → skip
  });

  it('--slug filters to a single entry', async () => {
    const yamlContent = `
- sourceId: A
  title: A entry
  url: https://api.sap.com/a
  description: Entry A for the slug-filter test.
  category: Test
  apiType: rest
- sourceId: B
  title: B entry
  url: https://api.sap.com/b
  description: Entry B for the slug-filter test.
  category: Test
  apiType: rest
`;
    const result = await runSeedApiDocs({ yamlContent, commit: true, slugFilter: 'ad-a' });
    expect(result.committed).toBe(1);
    const rows = await SELECT.from(ApiDocs);
    expect(rows).toHaveLength(1);
    expect(rows[0].slug).toBe('ad-a');
  });
});
