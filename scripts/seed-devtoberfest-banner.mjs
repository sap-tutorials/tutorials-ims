// One-shot: upload a local image as the active DevtoberfestConfig banner via
// the deployed AdminService uploadBanner bound action.
//
// Usage (after deploy, with a valid bearer token for the admin service):
//   ADMIN_SRV_URL="https://<srv-host>/admin" \
//   ADMIN_TOKEN="<bearer>" \
//   node scripts/seed-devtoberfest-banner.mjs "D:\\tmp\\devtoberfest\\key-visual-option1-banner-wide.png"
//
// Resolves the active config ID, then POSTs the base64 image to
// DevtoberfestConfig(<ID>)/com.sap.developers.ims.AdminService.uploadBanner.

import { readFile } from 'node:fs/promises';

const SRV = process.env.ADMIN_SRV_URL;
const TOKEN = process.env.ADMIN_TOKEN;
const file = process.argv[2];

if (!SRV || !TOKEN || !file) {
  console.error('Set ADMIN_SRV_URL + ADMIN_TOKEN env and pass an image path arg.');
  process.exit(1);
}

const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

const listRes = await fetch(`${SRV}/DevtoberfestConfig?$filter=isActive eq true&$select=ID`, { headers });
if (!listRes.ok) { console.error('list active config failed', listRes.status, await listRes.text()); process.exit(1); }
const { value } = await listRes.json();
if (!value?.length) { console.error('no active DevtoberfestConfig row'); process.exit(1); }
const ID = value[0].ID;

const bytes = await readFile(file);
const imageBase64 = bytes.toString('base64');
const mimeType = file.toLowerCase().endsWith('.png') ? 'image/png'
  : file.toLowerCase().endsWith('.webp') ? 'image/webp' : 'image/jpeg';

const action = `com.sap.developers.ims.AdminService.uploadBanner`;
const upRes = await fetch(`${SRV}/DevtoberfestConfig(${ID})/${action}`, {
  method: 'POST', headers, body: JSON.stringify({ imageBase64, mimeType }),
});
if (!upRes.ok) { console.error('uploadBanner failed', upRes.status, await upRes.text()); process.exit(1); }
console.log('Banner uploaded to active config', ID);
