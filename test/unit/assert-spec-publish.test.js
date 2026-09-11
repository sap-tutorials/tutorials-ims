// test/unit/assert-spec-publish.test.js
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { assertSpecPublishHandler } from '../../srv/lib/assert-spec-publish.js';

beforeAll(async () => {
  await cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:');
});

async function seedTutorials() {
  const { AssertSpecs, Tutorials } = cds.entities('com.sap.developers.ims');
  await DELETE.from(AssertSpecs);
  await DELETE.from(Tutorials);
  await INSERT.into(Tutorials).entries([
    { ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', slug: 'tutorial-alpha', title: 'Alpha', status: 'ACTIVE' },
    { ID: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', slug: 'tutorial-beta',  title: 'Beta',  status: 'ACTIVE' },
  ]);
}
beforeEach(seedTutorials);

const mockReq = (body) => ({ body });
const mockRes = () => ({
  statusCode: 200, jsonBody: null,
  status(c) { this.statusCode = c; return this; },
  json(b)   { this.jsonBody = b; return this; },
});

const cmd  = (over = {}) => ({ slug: 'tutorial-alpha', index: 0, stepNumber: 1, type: 'cmd', run: 'x', expectExit: 0, ...over });
const http = (over = {}) => ({ slug: 'tutorial-alpha', index: 0, stepNumber: 2, type: 'http', method: 'GET', path: '/x', expectStatus: 200, ...over });
const file = (over = {}) => ({ slug: 'tutorial-alpha', index: 0, stepNumber: 3, type: 'file', filePath: 'a.cds', expectContains: false, ...over });

describe('happy path + column mapping', () => {
  it('cmd/http/file each upsert with mapped columns', async () => {
    const res = mockRes();
    await assertSpecPublishHandler(mockReq({ specs: [cmd(), http(), file({ expectContains: true, match: 'svc' })] }), res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({ upserted: 3, skipped: [] });

    const { AssertSpecs } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(AssertSpecs);
    expect(rows).toHaveLength(3);
    const httpRow = rows.find(r => r.assertType === 'http');
    expect(httpRow.httpMethod).toBe('GET');
    expect(httpRow.httpPath).toBe('/x');
    expect(httpRow.expectStatus).toBe(200);
    const fileRow = rows.find(r => r.assertType === 'file');
    expect(fileRow.matchRegex).toBe('svc');
    expect(fileRow.expectContains).toBe(true);
  });
});

describe('multi-assert per step keyed on assertIndex', () => {
  it('two asserts on same step both persist', async () => {
    const res = mockRes();
    await assertSpecPublishHandler(mockReq({ specs: [
      cmd({ index: 0, stepNumber: 1 }),
      cmd({ index: 1, stepNumber: 1, run: 'y' }),
    ] }), res);
    expect(res.jsonBody.upserted).toBe(2);
    const { AssertSpecs } = cds.entities('com.sap.developers.ims');
    expect(await SELECT.from(AssertSpecs)).toHaveLength(2);
  });
});

describe('idempotent + carry-forward', () => {
  it('same payload twice → row count unchanged', async () => {
    const specs = [cmd()];
    await assertSpecPublishHandler(mockReq({ specs }), mockRes());
    await assertSpecPublishHandler(mockReq({ specs }), mockRes());
    const { AssertSpecs } = cds.entities('com.sap.developers.ims');
    expect(await SELECT.from(AssertSpecs)).toHaveLength(1);
  });

  it('row absent from second payload is retained', async () => {
    await assertSpecPublishHandler(mockReq({ specs: [cmd()] }), mockRes());
    await assertSpecPublishHandler(mockReq({ specs: [http()] }), mockRes());
    const { AssertSpecs } = cds.entities('com.sap.developers.ims');
    expect(await SELECT.from(AssertSpecs)).toHaveLength(2);
  });
});

describe('slug not found', () => {
  it('unknown slug skipped; known upserted', async () => {
    const res = mockRes();
    await assertSpecPublishHandler(mockReq({ specs: [cmd(), cmd({ slug: 'nope', stepNumber: 9 })] }), res);
    expect(res.jsonBody).toEqual({ upserted: 1, skipped: ['nope'] });
  });
});

describe('validation (fail-fast)', () => {
  it('null body → 400 invalid_body', async () => {
    const res = mockRes();
    await assertSpecPublishHandler(mockReq(null), res);
    expect(res.jsonBody).toEqual({ error: 'invalid_body' });
  });
  it('specs not array → 400 invalid_body', async () => {
    const res = mockRes();
    await assertSpecPublishHandler(mockReq({ specs: 'x' }), res);
    expect(res.jsonBody).toEqual({ error: 'invalid_body' });
  });
  it('missing slug → 400 invalid_spec', async () => {
    const res = mockRes();
    await assertSpecPublishHandler(mockReq({ specs: [cmd({ slug: undefined })] }), res);
    expect(res.jsonBody).toEqual({ error: 'invalid_spec' });
  });
  it('stepNumber as string → 400 invalid_spec', async () => {
    const res = mockRes();
    await assertSpecPublishHandler(mockReq({ specs: [cmd({ stepNumber: '1' })] }), res);
    expect(res.jsonBody).toEqual({ error: 'invalid_spec' });
  });
  it('index not a number → 400 invalid_spec', async () => {
    const res = mockRes();
    await assertSpecPublishHandler(mockReq({ specs: [cmd({ index: undefined })] }), res);
    expect(res.jsonBody).toEqual({ error: 'invalid_spec' });
  });
  it('unknown type → 400 invalid_spec', async () => {
    const res = mockRes();
    await assertSpecPublishHandler(mockReq({ specs: [cmd({ type: 'quantum' })] }), res);
    expect(res.jsonBody).toEqual({ error: 'invalid_spec' });
  });
  it('fail-fast: bad spec at position 1 prevents write of position 0', async () => {
    const res = mockRes();
    await assertSpecPublishHandler(mockReq({ specs: [cmd(), cmd({ type: 'bogus' })] }), res);
    expect(res.jsonBody).toEqual({ error: 'invalid_spec' });
    const { AssertSpecs } = cds.entities('com.sap.developers.ims');
    expect(await SELECT.from(AssertSpecs)).toHaveLength(0);
  });
});
