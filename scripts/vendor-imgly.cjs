#!/usr/bin/env node
'use strict';

// Vendors @imgly/background-removal-data assets for self-hosting.
//
// Background: the @imgly/background-removal npm package ships NO binary assets.
// All model (ONNX) and WASM files live in a separate data package on the IMG.LY
// CDN. At runtime the library fetches publicPath + 'resources.json' first (a
// manifest mapping logical asset names to content-addressed chunk filenames),
// then fetches each chunk by hash name. By setting publicPath='/vendor/imgly/'
// (see constants.ts) and vendoring all chunks here, we fully self-host with no
// CDN fetches — required by approuter CSP.
//
// Data package URL:
//   https://staticimgly.com/@imgly/background-removal-data/<VERSION>/package.tgz
// The <VERSION> is read from the installed @imgly/background-removal package so
// they always stay in sync.
//
// Dest layout: hugo/static/vendor/imgly/ (flat — chunks have no subdir)
// Served at: /vendor/imgly/
//
// RUNTIME_FILES is an explicit allowlist of all 87 files (resources.json +
// 86 content-addressed chunk files) from @imgly/background-removal-data@1.7.0.
// If a package upgrade changes the dist file set, the guard throws so a human
// can vet the new assets before they ship to browsers.
//
// Note: extraction uses a pure Node.js streaming tar parser (node:zlib) to
// avoid system tar path issues on Windows (Git Bash tar interprets Windows
// drive letters as remote hostnames).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

const ROOT = path.resolve(__dirname, '..');
const PKG_DIR = path.join(ROOT, 'hugo-apps', 'node_modules', '@imgly', 'background-removal');
const DEST_DIR = path.join(ROOT, 'hugo', 'static', 'vendor', 'imgly');

// Explicit allowlist of @imgly/background-removal-data@1.7.0 runtime files.
//
// resources.json   — manifest; library fetches this first to resolve chunk URLs
//
// Content-addressed chunks (sha256 hex names, flat in dist/):
//   /onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm  (6 chunks, ~23 MB)  WebGPU JSEP WASM
//   /onnxruntime-web/ort-wasm-simd-threaded.wasm       (3 chunks, ~12 MB)  CPU fallback WASM
//   /onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs   (1 chunk,  ~49 KB)  WebGPU JS glue
//   /onnxruntime-web/ort-wasm-simd-threaded.mjs        (1 chunk,  ~26 KB)  CPU JS glue
//   /models/isnet_quint8   (11 chunks, ~42 MB) — small quantized model
//   /models/isnet_fp16     (22 chunks, ~84 MB) — DEFAULT model (half-precision)
//   /models/isnet          (42 chunks, ~168 MB) — full-precision model
//
// Total: 86 chunks + resources.json = 87 files, ~329 MB on disk.
const RUNTIME_FILES = new Set([
  'resources.json',
  // ort-wasm-simd-threaded.jsep.wasm (WebGPU JSEP variant, 6 chunks)
  '9bd2256393c4c4fc105643b7d71d4d39e83c3577ffd91aa6d53ce8971f2ac995',
  '9232f8a6aabac61aee2a62e5a2556c83682dce65234d92455eb29fa0e7e98740',
  '0b5a74280e7b02e36dbb657b3e2a33480919507b6cf93750011d317d588d97d3',
  '50c6f203a499b1f5d6af3649f3d85159333dc720b1384d322b4070ae9a46dc19',
  'afd167a9b8713d055cca15b3595e0f296d1c68a285075c87c32ff52884120809',
  '3d1ff5fb0d1bc301e7b3b33b49636afd74f8dc837a9580fb084de1c9b7d3a81c',
  // ort-wasm-simd-threaded.wasm (CPU fallback, 3 chunks)
  '3dae4038fc722ce4ce041fbc9c63fd5c2d9864bc732a01994518f96e9ec2f357',
  'ff8e86f29887739d249494309ca84dff33bef456c0346c2bbfcd21e3b388d87a',
  '84addde9e759e397be2ee00d49a52dbf1b1a98863df325dc1c080252cbfe5fd9',
  // ort-wasm-simd-threaded.jsep.mjs (1 chunk)
  '2004e7fc76dd246901aaec08a7268cfb9832dcafa9e5a889b7f23f990ffe16ab',
  // ort-wasm-simd-threaded.mjs (1 chunk)
  'aa485cf3fa61ca007b3e1ca7b65068328270f072b61cdda490b732211e1da5d9',
  // /models/isnet_quint8 — quantized small model (11 chunks, ~42 MB)
  'f27ae13d9f59f61a6a1b5d9a91c203f2c613346083f02072c27c91672ccda8cf',
  '064e16ef5bd663f4c8b2d2531c018973282906db2b80c9995731340b84d28a47',
  '829842727f98368990f103f052e112e521dd27123b9f6b8615efa6cb32bfaa4f',
  '9d4c548caff42434be7b42d2f46e35a0da25f4d679ff4218b72bc8cf8fd4d291',
  'f3ce5fa0c5dc650423b4cb885d9fce1dbf043ee002c4a161688f36c2d2a122e0',
  '0a2415f50fe3072be594f7c4c66787f9465efed8dae6010b02f8575ea36bf81b',
  'a2385cccf96fda2efcf32b61349bc9c3a8ccb9be2246e45db6bfca6e37b78117',
  'ef08462567a199c89e0701ad47876c8fdc1b5eb487bbd6c2b58dd65fdc8bdc47',
  'e57a35056b1480bc581977524cf0c19994542cb044626cfffca0b304a6cf227c',
  'b7b88898b9ab9e43209322097282f88e9e02315273e291373366261cd0a77059',
  'b275d60a2e1790daff7c9040fd99a3897bfdf7d1550da1ccf8bea60902e9c585',
  // /models/isnet_fp16 — DEFAULT model, half-precision (22 chunks, ~84 MB)
  'a2a1f2d68cd58b5a6262755e434dee496fc0f27c0ba8fcbb5d57c56ffa1bb15f',
  '26a663c5a768f39155009f52e0f66815f36983ae275eec676365f7d09ef97edd',
  'a984abd436e7a8119dc170730260a37436ce0d0542984b71c5a1a386777ab7fd',
  '90741e8ae8b47de7666ae4163ba26087500d534973a853bbd02cea715f24b5ee',
  'cad6b95099faeba3ea1299d717990453208cc075b53332db9123a4e2bdaf160c',
  'c9f954707cb992edf62319d9aed365b4fc9ec3f08693a020db30040c0f953198',
  'f6e7e01556358ed875f260bdfb22fb6f7213ac6fd4098ed72c0e7af081f0c23c',
  '7b64520a3747dd5dcf6ac48f612504bb3b1e273a08b42b5a7efd614b9e4a397c',
  'bbf8e366b8f11bb64e60c8532fc2ffed21535fa1cf981464ac45485972107855',
  '12086412521285f855c2921ae13d3370ab243c9a250ebe340430075780f4624b',
  'ea46f83f60203065638f183fc8a5446dfc28a163d7ba1922fc3bc6cf40347fa2',
  '417316220b16ddd1c2a4730a315206ec0405aac7b64a878bdbe514e687b07b6f',
  'c1eba9d5d2ee58ba832bf98b50624ea8813f2279505643401c23674c6b326d0b',
  '378cd0ab154b324c0b1fe3136a605a8618865d4ce38824a30c938cc1e6312ce4',
  'f69890cf74d0a687904dd088c0aaadce598c8bc217366ebee6993eadd4d56208',
  'ef7fb517ae63534f48efa657702b3821fb5d59e4fd372016793edc0389341cc0',
  'dd4fad06953738263bc4d5f94974376467fc74081cba665cef18af8223894ed4',
  'fa3e4102c796fb6d1dab5417c5c0b4b5d219e6b9624d045d7361a033e7db183f',
  '9f0512f9be98be0f44ad2f9ec9fe706ae626f2037aca910df6d1396a06a30d41',
  '391ce9664d3a506e4333adb82581fc2dc6fbef0354f497ab417c050cb6eba6c4',
  '7b95dd2733643f999b985105afb755122ca36de12decadc7855ebfbdab6920e6',
  'af8fb2b72ffb03ed999778c4de73fd4ade196890be6e0253230b198dd11e9db0',
  // /models/isnet — full-precision large model (42 chunks, ~168 MB)
  '2a9f2f43b3c0b04201eebe1106da3d6871c1ea2c1eb9e55ee6b697a3f4708e2b',
  'b5b4a881eb1c9fda3963816602a389cc90643e30cc657c5479a72da6ed512222',
  '3ff495406dfe5fc6c2e08260d846a1994cac68e1a608c4966a4ba8fdd7c9d872',
  'c8c3fc74264dc6b805871b8a57e4ed94aa009c3cf27730684e655dbf7d94215e',
  '1d20c98bd16f6bbbf2bdc57226481c94b1a1063db7dcf7d80f2dad3482a4c8fe',
  '085ff37b1bd552c861cce6ac9f8df2efbdd5c6756c83925570ac429429e67d9d',
  '71466d935f14531311df7a32b983ca1e8add036bcc01771f76648784684a2935',
  '55b38ece3a166e88e8be91b198b489f4e779699f8bba8fe5eaa228b38d478b10',
  '4e58aa7ccbd85e9d0a5375ad271209e37c12e1e178ae694eb367314c153d1b47',
  'f040f407cea576fb3b15d40cb9e02baf12e61d63c5ad1855bf9a4a0afaa262cb',
  'c46dbfc4f56f4e84e8b7468883b3919b941951e3bea8b69b52f6000ea68ccb4f',
  '7c5e4cf3b63fa98419f46aeea25e5070df85cad351e24ec0e95083bdeb0479e9',
  '7d3248a72ab7618b02e3c5d0a6222ff417a6c9492f7648123ea5ce75013cec4b',
  'e383a2bd1ee394136941e081631d78dd777d57b3ddba05585a72ee55a46ce098',
  'ac2831584b644cd1f3ab1a82ff7a770355f0f182db38663dfd58994e5b30c916',
  'c1e9bb9b2df589645b3fdfb0b0047591f0d723536cb32ac5db656eb9b39c617a',
  '0aeaf1375d3fb1d52b664c8732db566b5eac418b522da85695fdb0b4273e2f52',
  '1570e009bf5b5cf282eb113e18f46b5c0c4624ab7daa11930ecdb2b700400c2f',
  'f40c284b3684588ee58b6e9b0ae88c7098df6f339940d9ed214869d309caf825',
  '0f2d9dc6abc71fb5022921f7a47c7252d749661f7aba9792e2917b8fba3a8d9f',
  '72487c55c32c9f91e0088b597cbfdaf509e3d21c854b461c6cf0f64397eec70c',
  '889bbd02dff6119232964a40990065d4c32c4e9db02a77a9adc9705117accd92',
  'e76c52dd27eb111b3503d5ffd182d332197f632a0d47050472de81447ea5bc30',
  'd822c052392a15da1fb2689d5262af5fd3c89c98e78c48fce987ee717c749291',
  '59d99a408b4c9e2a1b59f4051e29cce17ab740f0e82c63f6216871dfb7d1eb97',
  '0db78d66131c248c23d9d38d3cf8768f42241ef6c42d1c9455c914d347b1098d',
  '43b5db92e2b6a56d7c98133818a01e1502b50c2746899738f92dfca1778d44ea',
  '5ee53ffb0773030fec50804d92e9e89742f87b1fbbe8bef92c1e8ff39a681fa0',
  'f75d21d1f6972c76e79712314fb1f843fc8717df864f7bc659b54d092eff63a2',
  '8d5ea48683ed3cd24bbf5d7ea844e9f38b800d3d76e0f81800860198fd9f5870',
  'cee8b1cdc68963942f2bf3ba53088d955f8fc6e43e08361d5af8047a36371b25',
  '9f86a09c7d4a3e199c5d845726272092985ebdda0ec521f0c42ad15c2541537b',
  '3b33cf5cd61db85ae510613cd2420862450e9b0d53624274fff0611844f1ab69',
  'ab7a8f9f3709ad408b6a6ffcc9f1c1453edf93151f4128a34ba9e013a778c0d0',
  'd916ac311e5f7d2e747005f6ddaa997a0ba01de8f7b32165ef803876fc78fe1c',
  'a16be294e8f355ba587001dd240054b2599ff8d0324591296dec2c66edd10844',
  'e9922d1bf1981a767d99a8b2d9fde5e2c1b138bdff55c0c67693c00905d29e9f',
  'e91e6b0508bad89d7010fe265108dc6f96c02df395439f1157f8bd9918b217fc',
  '2b31a8e2868ab1c8ca4d43e392765153415bf794af35237d49004ef44238444b',
  '542787b61d12fd4c22c5e8fbc9ce7d95a69e29cc081dd4ebe3598560cf6ade43',
  '8f623e0bef85f9c51169ce5b8d20a5810b9bf7bf18055d5c5947f47325800ddf',
  '42d63b4a2ea543a5886321042be8d3cf390412ed4daea8a972dd76e745956717',
]);

// ---------------------------------------------------------------------------
// Pure Node.js streaming tar extractor.
//
// Avoids calling system tar which on Windows Git Bash treats Windows-style
// drive letters (C:, D:) as remote hostnames, causing extraction to fail.
// Uses node:zlib createGunzip + POSIX tar block parsing (512-byte blocks)
// via async iteration. Writes matching files directly to destDir.
//
// Returns the count of files extracted.
// ---------------------------------------------------------------------------
async function extractFromTgz(tgzPath, destDir, wantedFiles) {
  const BLOCK = 512;
  const wanted = new Set(wantedFiles);
  let accumulated = Buffer.allocUnsafe(0);
  let state = 'HEADER'; // 'HEADER' | 'DATA' | 'SKIP'
  let fileSize = 0;
  let filePadded = 0;
  let destFile = null;
  let extracted = 0;
  let unexpected = [];
  let missing = new Set(wantedFiles);

  const gunzip = zlib.createGunzip();
  fs.createReadStream(tgzPath).pipe(gunzip);

  for await (const chunk of gunzip) {
    accumulated = Buffer.concat([accumulated, chunk]);

    // Process all complete blocks we can right now.
    let progress = true;
    while (progress && state !== 'DONE') {
      progress = false;

      if (state === 'HEADER' && accumulated.length >= BLOCK) {
        const hdr = accumulated.subarray(0, BLOCK);

        // Two consecutive all-zero 512-byte blocks signal end-of-archive.
        let allZero = true;
        for (let i = 0; i < BLOCK; i++) {
          if (hdr[i] !== 0) { allZero = false; break; }
        }
        if (allZero) { state = 'DONE'; break; }

        // POSIX ustar header fields
        const name   = hdr.subarray(0, 100).toString('utf8').split('\0')[0];
        const prefix = hdr.subarray(345, 500).toString('utf8').split('\0')[0];
        const full   = prefix ? `${prefix}/${name}` : name;
        const type   = hdr[156]; // 0x30 = '0' regular, 0x00 = old regular, 0x35 = '5' dir
        const sizeOct = hdr.subarray(124, 136).toString('ascii').replace(/\0/g, '').trim();
        const size    = sizeOct ? parseInt(sizeOct, 8) : 0;
        const padded  = Math.ceil(size / BLOCK) * BLOCK;
        // basename: take the part after the last '/'
        const base    = full.replace(/\\/g, '/').split('/').pop();

        accumulated = accumulated.subarray(BLOCK); // consume header block

        if (size === 0) {
          // Directory entry or zero-byte file — no data blocks, stay in HEADER
          progress = true;
          continue;
        }

        if ((type === 0x30 || type === 0x00) && wanted.has(base)) {
          fileSize = size;
          filePadded = padded;
          destFile = base;
          missing.delete(base);
          state = 'DATA';
        } else {
          // Not a file we want — skip its data blocks
          filePadded = padded;
          state = 'SKIP';
        }
        progress = true;

      } else if (state === 'DATA' && accumulated.length >= filePadded) {
        // Write exact file bytes (discard the block padding after them)
        fs.writeFileSync(path.join(destDir, destFile), accumulated.subarray(0, fileSize));
        extracted++;
        accumulated = accumulated.subarray(filePadded);
        state = 'HEADER';
        progress = true;

      } else if (state === 'SKIP' && accumulated.length >= filePadded) {
        accumulated = accumulated.subarray(filePadded);
        state = 'HEADER';
        progress = true;
      }
    }

    if (state === 'DONE') break;
  }

  // Determine which files in the archive's dist/ were NOT in our allowlist
  // (we can't do this during streaming, so we rely on the caller's guard instead).
  return extracted;
}

// ---------------------------------------------------------------------------

async function main() {
  if (!fs.existsSync(PKG_DIR)) {
    throw new Error(
      `Missing ${PKG_DIR}. Run "npm --prefix hugo-apps install" first.`
    );
  }

  // Read the installed package version so the data tarball URL always matches.
  const pkgJson = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));
  const version = pkgJson.version;
  const dataUrl = `https://staticimgly.com/@imgly/background-removal-data/${version}/package.tgz`;

  fs.mkdirSync(DEST_DIR, { recursive: true });

  // Idempotency: if every RUNTIME_FILE is already present, skip entirely.
  const missing = [...RUNTIME_FILES].filter(
    (f) => !fs.existsSync(path.join(DEST_DIR, f))
  );
  if (missing.length === 0) {
    console.log(`  @imgly assets already present (${RUNTIME_FILES.size} files) — skipped`);
    console.log('@imgly assets up to date at', DEST_DIR);
    return;
  }

  console.log(
    `  ${RUNTIME_FILES.size - missing.length} of ${RUNTIME_FILES.size} files already present; ` +
    `downloading ${missing.length} missing from v${version} data package...`
  );
  console.log(`  source: ${dataUrl}`);

  // Download the data tarball to a temp file using Node native fetch.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgly-vendor-'));
  const tarball = path.join(tmpDir, 'package.tgz');

  try {
    const res = await fetch(dataUrl);
    if (!res.ok) throw new Error(`Failed to fetch ${dataUrl}: ${res.status} ${res.statusText}`);
    const dest = fs.createWriteStream(tarball);
    await pipeline(Readable.fromWeb(res.body), dest);
    const sizeMB = (fs.statSync(tarball).size / 1_048_576).toFixed(1);
    console.log(`  download complete (${sizeMB} MB)`);

    // Stream-extract directly from the downloaded tarball using pure Node.js
    // tar parsing — avoids system tar Windows path issues entirely.
    console.log(`  extracting ${missing.length} files...`);
    const extracted = await extractFromTgz(tarball, DEST_DIR, new Set(missing));

    // Guard: verify the extracted count matches what we expected.
    // Full set-drift check (unexpected/missing files in the package) requires
    // reading resources.json from the data tarball, which we can do post-extract.
    const resourcesPath = path.join(DEST_DIR, 'resources.json');
    if (fs.existsSync(resourcesPath)) {
      // Build the set of chunk hashes referenced in resources.json
      const resources = JSON.parse(fs.readFileSync(resourcesPath, 'utf8'));
      const referenced = new Set();
      for (const entry of Object.values(resources)) {
        for (const chunk of (entry.chunks || [])) {
          referenced.add(chunk.hash);
        }
      }
      referenced.add('resources.json');

      const unexpectedInPkg = [...referenced].filter((f) => !RUNTIME_FILES.has(f));
      const missingFromPkg  = [...RUNTIME_FILES].filter(
        (f) => f !== 'resources.json' && !referenced.has(f)
      );
      if (unexpectedInPkg.length > 0) {
        throw new Error(
          `Unexpected chunk(s) referenced in @imgly/background-removal-data@${version} resources.json:\n  ${unexpectedInPkg.join('\n  ')}\n` +
          `Add them to RUNTIME_FILES in scripts/vendor-imgly.cjs if legitimate, then re-run.`
        );
      }
      if (missingFromPkg.length > 0) {
        throw new Error(
          `RUNTIME_FILES contains chunk(s) not referenced in @imgly/background-removal-data@${version} resources.json:\n  ${missingFromPkg.join('\n  ')}\n` +
          `Remove them from RUNTIME_FILES in scripts/vendor-imgly.cjs.`
        );
      }
    }

    // Verify all expected files are now on disk
    const stillMissing = [...RUNTIME_FILES].filter(
      (f) => !fs.existsSync(path.join(DEST_DIR, f))
    );
    if (stillMissing.length > 0) {
      throw new Error(
        `Extraction incomplete — ${stillMissing.length} file(s) not written to ${DEST_DIR}:\n  ${stillMissing.join('\n  ')}`
      );
    }

    console.log(`  extracted ${extracted} files`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('@imgly assets vendored to', DEST_DIR);
}

main().catch((err) => { console.error(err); process.exit(1); });
