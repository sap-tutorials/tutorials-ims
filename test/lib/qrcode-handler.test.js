import { describe, it, expect } from 'vitest';
import { qrcodeHandler } from '../../srv/lib/qrcode-handler.js';

describe('qrcode-handler', () => {

  function mockReq(query) {
    return { query };
  }

  function mockRes() {
    const res = {
      statusCode: 200,
      headers: {},
      body: null,
      status(code) { res.statusCode = code; return res; },
      setHeader(key, val) { res.headers[key] = val; },
      send(data) { res.body = data; },
      json(data) { res.body = data; }
    };
    return res;
  }

  it('returns 400 when required params are missing', async () => {
    const res = mockRes();
    await qrcodeHandler(mockReq({}), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('Missing required parameters');
  });

  it('returns 400 when imsId is missing', async () => {
    const res = mockRes();
    await qrcodeHandler(mockReq({ type: 'TUTORIAL', eventId: '38' }), res);
    expect(res.statusCode).toBe(400);
  });

  it('generates a PNG image with valid params', async () => {
    const res = mockRes();
    await qrcodeHandler(mockReq({ imsId: '123', type: 'TUTORIAL', eventId: '38', recordId: '456' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('image/png');
    expect(res.headers['Cache-Control']).toContain('max-age');
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.slice(0, 4).toString('hex')).toBe('89504e47');
  });

  it('generates QR without recordId (defaults to 0)', async () => {
    const res = mockRes();
    await qrcodeHandler(mockReq({ imsId: '1', type: 'CHECKPOINT', eventId: '5' }), res);
    expect(res.statusCode).toBe(200);
    expect(Buffer.isBuffer(res.body)).toBe(true);
  });
});
