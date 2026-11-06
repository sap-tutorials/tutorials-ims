#!/usr/bin/env node
// scripts/vendor-asciinema.mjs
// Downloads asciinema-player v3.18.0 static assets from GitHub releases.
// Both files are placed in hugo/static/js/vendor/ (gitignored).
// Idempotent: skips if both files and sentinel are already present at the
// expected version.
//
// License: asciinema-player is Apache-2.0. REUSE.toml records both files.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEST_DIR = path.resolve(__dirname, '../hugo/static/js/vendor');
const VERSION = '3.18.0';
const SENTINEL = path.join(DEST_DIR, `.asciinema-vendored-${VERSION}`);

export async function main() {
  if (fs.existsSync(SENTINEL)) {
    console.log(`skipped (already v${VERSION})`);
    return;
  }

  const files = ['asciinema-player.min.js', 'asciinema-player.css'];

  for (const name of files) {
    const url = `https://github.com/asciinema/asciinema-player/releases/download/v${VERSION}/${name}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`Failed to download ${name}: ${res.status} ${res.statusText}`);
      process.exit(1);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(path.join(DEST_DIR, name), buf);
  }

  fs.writeFileSync(SENTINEL, VERSION);
  console.log(`vendored asciinema-player v${VERSION}`);
}

// Only run when invoked directly (not when imported by tests)
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(e => { console.error(e); process.exit(1); });
}
