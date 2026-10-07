import cds from '@sap/cds';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { excludedSlugsHandler } from '../../lib/content-store.js';

const NS = 'com.sap.developers.ims';

function makeReq(body = {}, headers = {}) {
  return { body, headers, get(k) { return this.headers[k.toLowerCase()]; } };
}
function makeRes() {
  const res = {
    _status: null, _body: null, _headers: {},
    status(code) { this._status = code; return this; },
    json(body)   { this._body = body; return this; },
    setHeader(k, v) { this._headers[k] = v; }
  };
  return res;
}

cds.test('serve', '--project', '.', '--in-memory');

describe('GET /content/excluded-slugs', () => {
  beforeAll(async () => { await cds.connect.to('db'); });

  beforeEach(async () => {
    const { Tutorials } = cds.entities(NS);
    await DELETE.from(Tutorials);
  });

  it('returns only DELETED and INACTIVE slugs, lowercased', async () => {
    const { Tutorials } = cds.entities(NS);
    await INSERT.into(Tutorials).entries([
      { ID: cds.utils.uuid(), slug: 'del-one', title: 't', status: 'DELETED' },
      { ID: cds.utils.uuid(), slug: 'Inact-Two', title: 't', status: 'INACTIVE' },
      { ID: cds.utils.uuid(), slug: 'active-three', title: 't', status: 'ACTIVE' },
      { ID: cds.utils.uuid(), slug: 'null-four', title: 't', status: null },
    ]);
    const res = makeRes();
    await excludedSlugsHandler(makeReq(), res);
    expect(res._body).toBeTruthy();
    const slugs = res._body.slugs.slice().sort();
    expect(slugs).toEqual(['del-one', 'inact-two']);
  });

  it('returns empty array when nothing is excluded', async () => {
    const res = makeRes();
    await excludedSlugsHandler(makeReq(), res);
    expect(res._body.slugs).toEqual([]);
  });
});
