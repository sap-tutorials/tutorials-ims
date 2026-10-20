// test/unit/prize-barcode-handler.test.js
// GET /api/my-prize-barcode?eventId=<legacyId>
// — mints a QR PNG encoding { uid, payload: { eventId } } for the authenticated visitor.
// The user's DB UUID is read from the session (resolveDbUserScoped), never from query params.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- module-level mocks (hoisted by vitest) ---

vi.mock('../../srv/lib/resolve-db-user.js', () => ({
  resolveDbUserScoped: vi.fn(),
}));

vi.mock('qrcode', () => ({
  default: {
    toBuffer: vi.fn(),
  },
}));

import { prizeBarcodeHandler } from '../../srv/lib/prize-barcode-handler.js';
import { resolveDbUserScoped } from '../../srv/lib/resolve-db-user.js';
import QRCode from 'qrcode';

// ---------------------------------------------------------------------------

function makeRes() {
  const headers = {};
  const res = {
    _headers: headers,
    _status: null,
    _body: null,
    setHeader(k, v) { headers[k] = v; },
    status(code) { res._status = code; return res; },
    json(body) { res._body = body; return res; },
    send(buf) { res._body = buf; return res; },
  };
  return res;
}

function makeReq(query = {}) {
  return { query, user: { id: 'xsuaa-user-1' } };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('prizeBarcodeHandler', () => {
  describe('resolved user → 200 image/png', () => {
    it('sets Content-Type image/png and Cache-Control private,no-store', async () => {
      resolveDbUserScoped.mockResolvedValue({ ID: 'uuid-123' });
      const fakeBuffer = Buffer.from('PNG_DATA');
      QRCode.toBuffer.mockResolvedValue(fakeBuffer);

      const req = makeReq({ eventId: '10000015' });
      const res = makeRes();

      await prizeBarcodeHandler(req, res);

      expect(res._headers['Content-Type']).toBe('image/png');
      expect(res._headers['Cache-Control']).toBe('private, no-store');
      expect(res._body).toBe(fakeBuffer);
      expect(res._status).toBeNull(); // default 200
    });

    it('encodes payload { uid, payload: { eventId } } as JSON to QRCode.toBuffer', async () => {
      resolveDbUserScoped.mockResolvedValue({ ID: 'uuid-123' });
      QRCode.toBuffer.mockResolvedValue(Buffer.from('PNG'));

      const req = makeReq({ eventId: '10000015' });
      const res = makeRes();

      await prizeBarcodeHandler(req, res);

      expect(QRCode.toBuffer).toHaveBeenCalledOnce();
      const [payloadStr, opts] = QRCode.toBuffer.mock.calls[0];
      expect(JSON.parse(payloadStr)).toEqual({
        uid: 'uuid-123',
        payload: { eventId: 10000015 },
      });
      expect(opts).toMatchObject({
        type: 'png',
        width: 200,
        margin: 2,
        errorCorrectionLevel: 'M',
      });
    });

    it('calls resolveDbUserScoped with the request and ["ID"]', async () => {
      resolveDbUserScoped.mockResolvedValue({ ID: 'uuid-abc' });
      QRCode.toBuffer.mockResolvedValue(Buffer.from('PNG'));

      const req = makeReq({ eventId: '42' });
      const res = makeRes();

      await prizeBarcodeHandler(req, res);

      expect(resolveDbUserScoped).toHaveBeenCalledWith(req, ['ID']);
    });
  });

  describe('unresolved user → 401', () => {
    it('returns 401 when resolveDbUserScoped returns null', async () => {
      resolveDbUserScoped.mockResolvedValue(null);

      const req = makeReq({ eventId: '10000015' });
      const res = makeRes();

      await prizeBarcodeHandler(req, res);

      expect(res._status).toBe(401);
      expect(res._body).toEqual({ error: 'authentication required' });
      expect(QRCode.toBuffer).not.toHaveBeenCalled();
    });

    it('returns 401 when resolveDbUserScoped returns undefined', async () => {
      resolveDbUserScoped.mockResolvedValue(undefined);

      const req = makeReq({ eventId: '10000015' });
      const res = makeRes();

      await prizeBarcodeHandler(req, res);

      expect(res._status).toBe(401);
      expect(res._body).toEqual({ error: 'authentication required' });
    });
  });

  describe('QR generation failure → 500', () => {
    it('returns 500 when QRCode.toBuffer rejects', async () => {
      resolveDbUserScoped.mockResolvedValue({ ID: 'uuid-123' });
      QRCode.toBuffer.mockRejectedValue(new Error('qr gen failed'));

      const req = makeReq({ eventId: '10000015' });
      const res = makeRes();

      await prizeBarcodeHandler(req, res);

      expect(res._status).toBe(500);
      expect(res._body).toEqual({ error: 'QR code generation failed' });
    });
  });
});
