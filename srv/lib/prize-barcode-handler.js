import QRCode from 'qrcode';
import { getOrProvisionDbUser, resolveUserSapId } from './resolve-db-user.js';

/**
 * GET /api/my-prize-barcode?eventId=<legacyId>
 *
 * Mints a QR PNG encoding { uid: <Users.ID>, payload: { eventId: Number } }
 * for the authenticated visitor. Identity is always resolved from the session
 * (getOrProvisionDbUser) — never from a client-supplied query parameter. Uses
 * the same tiered resolver as the Devtoberfest/gameboard path so social / IAS /
 * GitHub / null-sapId logins map to their one canonical Users row (#2730/#2651),
 * and the encoded uid matches what ScannerService.getContestant looks up.
 *
 * Cache-Control: private, no-store — this response is identity-bearing.
 */
export async function prizeBarcodeHandler(req, res) {
  const sapId = resolveUserSapId(req.user);
  const user = await getOrProvisionDbUser(req, { sapId }, ['ID']);

  if (!user) {
    return res.status(401).json({ error: 'authentication required' });
  }

  const eventId = Number(req.query.eventId);
  const payload = JSON.stringify({
    uid: user.ID,
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
