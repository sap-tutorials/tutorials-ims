// test/unit/prize-barcode-handler.test.js
// GET /api/my-prize-barcode?eventId=<legacyId>
// — mints a QR PNG encoding { uid, payload: { eventId } } for the authenticated visitor.
// Identity is resolved from the session (cds.context.user, with a req.user fallback)
// via the canonical get-or-create provisionDbUser — the same front door the other raw
// Express routes use (srv/server.js /auth/user, srv/routes/devtoberfest-*). Never from
// a client-supplied query param.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- module-level mocks (hoisted by vitest) ---

vi.mock('../../srv/lib/resolve-db-user.js', () => ({
  provisionDbUser: vi.fn(),
}));

// cds.context is an AsyncLocalStorage-backed getter on the real @sap/cds. Mock
// the default export so we can drive cds.context.user per test — this is the
// identity CAP's auth() middleware populates on a raw Express bootstrap route
// (req.user is NOT reliably set there; that was the #2861 401 root cause).
vi.mock('@sap/cds', () => ({
  default: { context: { user: null } },
}));

vi.mock('qrcode', () => ({
  default: {
    toBuffer: vi.fn(),
  },
}));

import { prizeBarcodeHandler } from '../../srv/lib/prize-barcode-handler.js';
import { provisionDbUser } from '../../srv/lib/resolve-db-user.js';
import cds from '@sap/cds';
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

// req.user present (CAP service-handler / mocked-basic-auth shape)
function makeReqWithUser(query = {}) {
  return { query, user: { id: 'xsuaa-user-1' } };
}

// req.user absent — the REAL XSUAA/IAS bootstrap-route shape: the authenticated
// identity lives on cds.context.user, not on the Express req. Reproduces #2861.
function makeReqNoUser(query = {}) {
  return { query, user: undefined };
}

beforeEach(() => {
  vi.clearAllMocks();
  cds.context.user = null;
});

describe('prizeBarcodeHandler', () => {
  describe('resolved user → 200 image/png', () => {
    it('sets Content-Type image/png and Cache-Control private,no-store', async () => {
      provisionDbUser.mockResolvedValue({ ID: 'uuid-123' });
      const fakeBuffer = Buffer.from('PNG_DATA');
      QRCode.toBuffer.mockResolvedValue(fakeBuffer);

      const req = makeReqWithUser({ eventId: '10000015' });
      const res = makeRes();

      await prizeBarcodeHandler(req, res);

      expect(res._headers['Content-Type']).toBe('image/png');
      expect(res._headers['Cache-Control']).toBe('private, no-store');
      expect(res._body).toBe(fakeBuffer);
      expect(res._status).toBeNull(); // default 200
    });

    it('encodes payload { uid, payload: { eventId } } as JSON to QRCode.toBuffer', async () => {
      provisionDbUser.mockResolvedValue({ ID: 'uuid-123' });
      QRCode.toBuffer.mockResolvedValue(Buffer.from('PNG'));

      const req = makeReqWithUser({ eventId: '10000015' });
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

    // #2861 follow-up REGRESSION GUARD — the operative bug. On a raw Express
    // bootstrap route CAP's auth() populates cds.context.user, NOT req.user. The
    // shipped fix read bare req.user → anonymous → provision null → 401 for EVERY
    // real logged-in visitor. The mocked-basic-auth integration harness hid it
    // (it DOES set req.user). Assert the handler resolves from cds.context.user
    // when req.user is absent, and encodes that canonical ID into the QR.
    it('resolves identity from cds.context.user when req.user is absent (the #2861 401)', async () => {
      cds.context.user = { id: 'ias-user-9' };
      provisionDbUser.mockResolvedValue({ ID: 'uuid-ctx' });
      QRCode.toBuffer.mockResolvedValue(Buffer.from('PNG'));

      const req = makeReqNoUser({ eventId: '10000015' });
      const res = makeRes();

      await prizeBarcodeHandler(req, res);

      expect(provisionDbUser).toHaveBeenCalledWith({ id: 'ias-user-9' }, ['ID']);
      expect(res._status).toBeNull(); // 200, not 401
      const [payloadStr] = QRCode.toBuffer.mock.calls[0];
      expect(JSON.parse(payloadStr).uid).toBe('uuid-ctx');
    });

    it('prefers req.user when it carries a real (non-anonymous) identity', async () => {
      cds.context.user = { id: 'ctx-fallback' };
      provisionDbUser.mockResolvedValue({ ID: 'uuid-req' });
      QRCode.toBuffer.mockResolvedValue(Buffer.from('PNG'));

      const req = makeReqWithUser({ eventId: '7' });
      const res = makeRes();

      await prizeBarcodeHandler(req, res);

      expect(provisionDbUser).toHaveBeenCalledWith({ id: 'xsuaa-user-1' }, ['ID']);
    });
  });

  describe('anonymous / unresolved user → 401', () => {
    it('returns 401 when neither req.user nor cds.context.user is authenticated', async () => {
      cds.context.user = null;
      const req = makeReqNoUser({ eventId: '10000015' });
      const res = makeRes();

      await prizeBarcodeHandler(req, res);

      expect(res._status).toBe(401);
      expect(res._body).toEqual({ error: 'authentication required' });
      expect(provisionDbUser).not.toHaveBeenCalled();
      expect(QRCode.toBuffer).not.toHaveBeenCalled();
    });

    it('returns 401 when the user id is the anonymous sentinel', async () => {
      cds.context.user = { id: 'anonymous' };
      const req = makeReqNoUser({ eventId: '10000015' });
      const res = makeRes();

      await prizeBarcodeHandler(req, res);

      expect(res._status).toBe(401);
      expect(provisionDbUser).not.toHaveBeenCalled();
    });

    it('returns 401 when provisionDbUser returns null (mint declined — empty-profile token)', async () => {
      cds.context.user = { id: 'ias-user-9' };
      provisionDbUser.mockResolvedValue(null);

      const req = makeReqNoUser({ eventId: '10000015' });
      const res = makeRes();

      await prizeBarcodeHandler(req, res);

      expect(res._status).toBe(401);
      expect(res._body).toEqual({ error: 'authentication required' });
      expect(QRCode.toBuffer).not.toHaveBeenCalled();
    });
  });

  describe('QR generation failure → 500', () => {
    it('returns 500 when QRCode.toBuffer rejects', async () => {
      cds.context.user = { id: 'ias-user-9' };
      provisionDbUser.mockResolvedValue({ ID: 'uuid-123' });
      QRCode.toBuffer.mockRejectedValue(new Error('qr gen failed'));

      const req = makeReqNoUser({ eventId: '10000015' });
      const res = makeRes();

      await prizeBarcodeHandler(req, res);

      expect(res._status).toBe(500);
      expect(res._body).toEqual({ error: 'QR code generation failed' });
    });
  });
});
