#!/usr/bin/env tsx
// scripts/check-kg-meta-formatters-mirror.ts
//
// CI guard: verify the byte-equality of the authoritative KG meta
// formatters module (srv/lib/kg-meta-formatters.js) against its mirror
// under hugo-apps (hugo-apps/src/related-graph/kg-meta-formatters.js).
// The Vite root and the CAP build tree can't share source files, so we
// keep two copies in sync with this guard. CRLF vs LF differences are
// normalised — Windows checkouts don't spuriously fail.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.KG_MIRROR_ROOT
  ? resolve(process.env.KG_MIRROR_ROOT)
  : resolve(__dirname, '..');

const SRV_PATH = join(REPO_ROOT, 'srv', 'lib', 'kg-meta-formatters.js');
const MIRROR_PATH = join(REPO_ROOT, 'hugo-apps', 'src', 'related-graph', 'kg-meta-formatters.js');

function readNormalised(p: string): string {
  return readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}

try {
  const srv = readNormalised(SRV_PATH);
  const mirror = readNormalised(MIRROR_PATH);
  if (srv !== mirror) {
    console.error(
      `[check-kg-meta-formatters-mirror] DRIFT — ${SRV_PATH} and ${MIRROR_PATH} differ.\n` +
      `Regenerate the mirror: cp ${SRV_PATH} ${MIRROR_PATH}`
    );
    process.exit(1);
  }
  console.log('[check-kg-meta-formatters-mirror] OK');
} catch (err: unknown) {
  const e = err as { code?: string; path?: string; message?: string };
  console.error(
    `[check-kg-meta-formatters-mirror] MISSING — could not read ${e.path ?? '(unknown)'}: ${e.message ?? err}\n` +
    `Expected files: ${SRV_PATH} and ${MIRROR_PATH}`
  );
  process.exit(1);
}
