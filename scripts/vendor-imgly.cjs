#!/usr/bin/env node
'use strict';

// Vendors @imgly/background-removal-data assets for self-hosting.
//
// Background: the @imgly/background-removal npm package ships NO binary assets.
// All model (ONNX) and WASM files live in a separate data package on the IMG.LY
// CDN. At runtime the library fetches publicPath + 'resources.json' first (a
// manifest mapping logical asset names to content-addressed chunk filenames),
// then fetches each chunk by hash name. By setting publicPath='/vendor/imgly/'
// (constants.ts in the selfie island) and vendoring the required files here, we
// fully self-host with no CDN fetches — required by approuter CSP.
//
// We vendor ONLY the assets the app actually uses:
//   - resources.json (full manifest — tiny, kept complete so all keys present)
//   - /onnxruntime-web/* chunks (4 entries, 11 chunks) — WASM + JS glue
//   - /models/isnet_quint8 chunks (11 chunks, ~42 MB) — the lightest model
//
// isnet_fp16 (~84 MB) and isnet (~168 MB) are NOT vendored; Task 5 configures
// model: 'isnet_quint8'. Total on-disk: ~77 MB (vs 328 MB for all three).
//
// Data package URL:
//   https://staticimgly.com/@imgly/background-removal-data/<VERSION>/package.tgz
// VERSION is read from the installed @imgly/background-removal package.
//
// Dest layout: hugo/static/vendor/imgly/ (flat)  →  served at /vendor/imgly/
//
// Idempotency + version tracking:
//   A sentinel file .imgly-vendored-version is written alongside the chunks
//   after each successful run. If the sentinel is missing OR its recorded
//   version differs from the currently-installed package version, the dest dir
//   is wiped and re-vendored (prevents stale old-version chunks when a developer
//   bumps the package version, reinstalls, and re-runs vendor:imgly locally).
//   CI is unaffected — clean envs have no pre-existing dest.
//
// Drift guard:
//   The copy set is derived at run time from resources.json. A structural guard
//   checks that the 4 onnxruntime-web keys and 3 model keys still exist (throws
//   on key addition/removal so a human vets upgrades). Hard-coding chunk hashes
//   is avoided so the guard adapts to upstream chunk splits automatically.
//
// Note: extraction uses a pure Node.js streaming tar parser (node:zlib) to
// avoid system tar path issues on Windows (Git Bash tar treats Windows
// drive-letter paths as remote hostnames).

const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { Readable }  = require('node:stream');

const ROOT      = path.resolve(__dirname, '..');
const PKG_DIR   = path.join(ROOT, 'hugo-apps', 'node_modules', '@imgly', 'background-removal');
const DEST_DIR  = path.join(ROOT, 'hugo', 'static', 'vendor', 'imgly');
const SENTINEL  = path.join(DEST_DIR, '.imgly-vendored-version');

// Structural guards on resources.json top-level keys.
// Throws if the data package adds or removes keys between versions so a human
// can decide whether the change affects what we need to vendor.
const EXPECTED_ONNX_KEYS = [
  '/onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm',
  '/onnxruntime-web/ort-wasm-simd-threaded.wasm',
  '/onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs',
  '/onnxruntime-web/ort-wasm-simd-threaded.mjs',
];
const EXPECTED_MODEL_KEYS = ['/models/isnet_quint8', '/models/isnet_fp16', '/models/isnet'];

// ---------------------------------------------------------------------------
// Pure Node.js streaming POSIX tar extractor (512-byte block format).
// Writes only files whose basename is in wantedSet. Returns files written.
// ---------------------------------------------------------------------------
async function extractFromTgz(tgzPath, destDir, wantedSet) {
  const BLOCK = 512;
  let buf = Buffer.allocUnsafe(0);
  let state = 'HEADER';
  let fileSize = 0, filePadded = 0, destFile = null, extracted = 0;
  const NUL = String.fromCharCode(0);

  const gunzip = zlib.createGunzip();
  fs.createReadStream(tgzPath).pipe(gunzip);

  for await (const chunk of gunzip) {
    buf = Buffer.concat([buf, chunk]);
    let go = true;
    while (go && state !== 'DONE') {
      go = false;
      if (state === 'HEADER' && buf.length >= BLOCK) {
        const hdr = buf.subarray(0, BLOCK);
        let allZero = true;
        for (let i = 0; i < BLOCK; i++) { if (hdr[i]) { allZero = false; break; } }
        if (allZero) { state = 'DONE'; break; }
        const name    = hdr.subarray(0, 100).toString('utf8').split(NUL)[0];
        const prefix  = hdr.subarray(345, 500).toString('utf8').split(NUL)[0];
        const full    = prefix ? `${prefix}/${name}` : name;
        const type    = hdr[156]; // 0x30/'0'=regular, 0x00=old-reg, 0x35/'5'=dir
        const sizeStr = hdr.subarray(124, 136).toString('ascii').replace(new RegExp(NUL, 'g'), '').trim();
        const size    = sizeStr ? parseInt(sizeStr, 8) : 0;
        const padded  = Math.ceil(size / BLOCK) * BLOCK;
        const base    = full.split('/').pop();
        buf = buf.subarray(BLOCK);
        if (!size) { go = true; continue; }
        if ((type === 0x30 || type === 0x00) && wantedSet.has(base)) {
          fileSize = size; filePadded = padded; destFile = base; state = 'DATA';
        } else {
          filePadded = padded; state = 'SKIP';
        }
        go = true;
      } else if (state === 'DATA' && buf.length >= filePadded) {
        fs.writeFileSync(path.join(destDir, destFile), buf.subarray(0, fileSize));
        extracted++;
        buf = buf.subarray(filePadded); state = 'HEADER'; go = true;
      } else if (state === 'SKIP' && buf.length >= filePadded) {
        buf = buf.subarray(filePadded); state = 'HEADER'; go = true;
      }
    }
    if (state === 'DONE') break;
  }
  return extracted;
}

// ---------------------------------------------------------------------------

async function main() {
  if (!fs.existsSync(PKG_DIR)) {
    throw new Error(`Missing ${PKG_DIR}. Run "npm --prefix hugo-apps install" first.`);
  }

  const pkgJson = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));
  const version = pkgJson.version;
  const dataUrl = `https://staticimgly.com/@imgly/background-removal-data/${version}/package.tgz`;

  fs.mkdirSync(DEST_DIR, { recursive: true });

  // ---- Step 1: version sentinel check ----
  // If the sentinel records a different version, wipe dest so stale old-version
  // chunks cannot linger after a package bump + reinstall.
  const vendoredVersion = fs.existsSync(SENTINEL)
    ? fs.readFileSync(SENTINEL, 'utf8').trim()
    : null;

  if (vendoredVersion !== null && vendoredVersion !== version) {
    console.log(
      `  detected version change (vendored=${vendoredVersion}, installed=${version}) — wiping stale assets`
    );
    fs.rmSync(DEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(DEST_DIR, { recursive: true });
  }

  // ---- Step 2: early-return if already fully up to date ----
  // Requires sentinel version matches AND resources.json present (from which we
  // derive the copy set to check file completeness).
  // tmpDir is NOT created on this path — no needless syscall on the hot path.
  const manifestDest = path.join(DEST_DIR, 'resources.json');
  if (vendoredVersion === version && fs.existsSync(manifestDest)) {
    const resources  = JSON.parse(fs.readFileSync(manifestDest, 'utf8'));
    const copyKeys   = [...EXPECTED_ONNX_KEYS, '/models/isnet_quint8'];
    const chunkNames = new Set(['resources.json']);
    for (const k of copyKeys) {
      for (const c of resources[k].chunks) chunkNames.add(c.name);
    }
    const missingFiles = [...chunkNames].filter(f => !fs.existsSync(path.join(DEST_DIR, f)));
    if (missingFiles.length === 0) {
      console.log(`  @imgly assets already present (${chunkNames.size} files) — skipped`);
      console.log('@imgly assets up to date at', DEST_DIR);
      return;
    }
    // sentinel matched but some chunks missing — fall through to download
    console.log(`  ${missingFiles.length} chunk(s) missing despite sentinel match — re-fetching`);
  }

  // ---- Step 3: download the data tarball (single download covers all files) ----
  // tmpDir is created only here, never on the idempotent early-return path above.
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'imgly-vendor-'));
  const tarball = path.join(tmpDir, 'package.tgz');

  try {
    await downloadTarball(dataUrl, tarball);

    // ---- Step 4: extract resources.json to read the manifest ----
    if (!fs.existsSync(manifestDest)) {
      await extractFromTgz(tarball, DEST_DIR, new Set(['resources.json']));
    }
    const resources = JSON.parse(fs.readFileSync(manifestDest, 'utf8'));

    // ---- Step 5: structural guard on resources.json ----
    const allKeys       = Object.keys(resources);
    const missingOnnx   = EXPECTED_ONNX_KEYS.filter(k => !allKeys.includes(k));
    const missingModels = EXPECTED_MODEL_KEYS.filter(k => !allKeys.includes(k));
    const extraKeys     = allKeys.filter(
      k => !EXPECTED_ONNX_KEYS.includes(k) && !EXPECTED_MODEL_KEYS.includes(k)
    );
    if (missingOnnx.length || missingModels.length || extraKeys.length) {
      throw new Error(
        `@imgly/background-removal-data@${version} resources.json structure changed — ` +
        `human review required before vendoring.\n` +
        (missingOnnx.length   ? `  Missing onnxruntime-web keys: ${missingOnnx.join(', ')}\n`  : '') +
        (missingModels.length ? `  Missing model keys: ${missingModels.join(', ')}\n`           : '') +
        (extraKeys.length     ? `  Unexpected new keys: ${extraKeys.join(', ')}\n`              : '') +
        `Update EXPECTED_ONNX_KEYS / EXPECTED_MODEL_KEYS in scripts/vendor-imgly.cjs after vetting.`
      );
    }

    // ---- Step 6: compute copy set and extract missing chunks ----
    const copyKeys   = [...EXPECTED_ONNX_KEYS, '/models/isnet_quint8'];
    const chunkNames = new Set(['resources.json']);
    for (const k of copyKeys) {
      for (const c of resources[k].chunks) chunkNames.add(c.name);
    }

    const missingFiles = [...chunkNames].filter(f => !fs.existsSync(path.join(DEST_DIR, f)));
    console.log(
      `  ${chunkNames.size - missingFiles.length} of ${chunkNames.size} files present; ` +
      `extracting ${missingFiles.length} missing...`
    );

    const toExtract = new Set(missingFiles.filter(f => f !== 'resources.json'));
    if (toExtract.size > 0) {
      const n = await extractFromTgz(tarball, DEST_DIR, toExtract);
      console.log(`  extracted ${n} files`);
    }

    // ---- Step 7: verify all expected files landed on disk ----
    const stillMissing = [...chunkNames].filter(f => !fs.existsSync(path.join(DEST_DIR, f)));
    if (stillMissing.length > 0) {
      throw new Error(
        `Extraction incomplete — ${stillMissing.length} file(s) not written to ${DEST_DIR}:\n` +
        `  ${stillMissing.join('\n  ')}`
      );
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // ---- Step 8: write version sentinel ----
  fs.writeFileSync(SENTINEL, `${version}\n`);

  console.log('@imgly assets vendored to', DEST_DIR);
}

async function downloadTarball(url, dest) {
  console.log(`  fetching ${url} ...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  const out = fs.createWriteStream(dest);
  await pipeline(Readable.fromWeb(res.body), out);
  const sizeMB = (fs.statSync(dest).size / 1_048_576).toFixed(1);
  console.log(`  download complete (${sizeMB} MB)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
