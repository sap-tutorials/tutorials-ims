import QRCode from 'qrcode';

export async function qrcodeHandler(req, res) {
  const { imsId, type, eventId, recordId } = req.query;

  if (!imsId || !type || !eventId) {
    return res.status(400).json({ error: 'Missing required parameters: imsId, type, eventId' });
  }

  const payload = JSON.stringify({
    imsId: Number(imsId),
    type,
    eventId: Number(eventId),
    recordId: Number(recordId) || 0
  });

  try {
    const buffer = await QRCode.toBuffer(payload, {
      type: 'png',
      width: 200,
      margin: 2,
      errorCorrectionLevel: 'M'
    });

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: 'QR code generation failed' });
  }
}
