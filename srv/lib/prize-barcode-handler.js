import QRCode from 'qrcode';
import cds from '@sap/cds';
import { provisionDbUser } from './resolve-db-user.js';

/**
 * GET /api/my-prize-barcode?eventId=<legacyId>
 *
 * Mints a QR PNG encoding { uid: <Users.ID>, payload: { eventId: Number } }
 * for the authenticated visitor. Identity is always resolved from the session
 * (cds.context.user → provisionDbUser) — never from a client-supplied query
 * parameter. Uses the same tiered resolver as the Devtoberfest/gameboard path
 * so social / IAS / GitHub / null-sapId logins map to their one canonical Users
 * row (#2730/#2651), and the encoded uid matches what
 * ScannerService.getContestant looks up.
 *
 * Cache-Control: private, no-store — this response is identity-bearing.
 */
export async function prizeBarcodeHandler(req, res) {
  // On a raw Express bootstrap route, CAP's auth() middleware populates the
  // authenticated identity on cds.context.user (the AsyncLocalStorage
  // continuation), NOT reliably on req.user — req.user is only set in CAP
  // service handlers and the mocked-basic-auth test harness. Reading bare
  // req.user here made every real XSUAA/IAS login resolve to anonymous → a
  // hard 401 for every logged-in visitor (#2861 follow-up). Resolve from
  // cds.context.user with a req.user fallback, the same idiom the working
  // /api/alerts/me and /auth/user routes use (srv/routes/alerts-public.js,
  // srv/server.js).
  const user = req.user?.id && req.user.id !== 'anonymous' ? req.user : cds.context?.user;
  if (!user?.id || user.id === 'anonymous') {
    return res.status(401).json({ error: 'authentication required' });
  }

  // provisionDbUser is the canonical get-or-create used by the other raw
  // Express routes (srv/server.js /auth/user, srv/routes/devtoberfest-*): it
  // runs the tiered resolver (iss/sub link → social / IAS / GitHub / null-sapId
  // map to the one canonical Users row, #2730/#2651) and mints the row on a
  // first-time visitor from the token claims. The encoded uid then matches what
  // ScannerService.getContestant looks up. Unlike getOrProvisionDbUser it takes
  // the user object directly (no CAP-request .tx coupling), which is correct
  // for a bootstrap Express route where req is not a CAP request.
  const dbUser = await provisionDbUser(user, ['ID']);

  if (!dbUser) {
    return res.status(401).json({ error: 'authentication required' });
  }

  const eventId = Number(req.query.eventId);
  const payload = JSON.stringify({
    uid: dbUser.ID,
    payload: { eventId },
  });

  try {
    const buffer = await QRCode.toBuffer(payload, {
      type: 'png',
      width: 200,
      margin: 2,
      errorCorrectionLevel: 'M',
    });

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: 'QR code generation failed' });
  }
}
