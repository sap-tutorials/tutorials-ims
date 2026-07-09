#!/usr/bin/env node
// Substitutes ${XSUAA_TENANT}, ${XSUAA_REGION}, ${BASE_URL} in the .well-known
// templates and writes them (without .template suffix) to --out. Invoked from
// .deploy/mta.yaml's approuter module build step.

import fs from 'node:fs';
import path from 'node:path';

const argv = Object.fromEntries(
  process.argv.slice(2).reduce((acc, tok, i, arr) => {
    if (tok.startsWith('--')) acc.push([tok.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);

const { tenant, region, 'base-url': baseUrl, out } = argv;
if (!tenant || !region || !baseUrl || !out) {
  console.error('Usage: build-well-known.mjs --tenant X --region Y --base-url Z --out DIR');
  process.exit(1);
}

fs.mkdirSync(out, { recursive: true });
const srcDir = 'approuter/static/.well-known';
for (const fname of fs.readdirSync(srcDir)) {
  if (!fname.endsWith('.template')) continue;
  const raw = fs.readFileSync(path.join(srcDir, fname), 'utf8');
  const out1 = raw
    .replaceAll('${XSUAA_TENANT}', tenant)
    .replaceAll('${XSUAA_REGION}', region)
    .replaceAll('${BASE_URL}', baseUrl);
  const outFile = path.join(out, fname.replace(/\.template$/, ''));
  fs.writeFileSync(outFile, out1);
  console.log(`wrote ${outFile}`);
}
