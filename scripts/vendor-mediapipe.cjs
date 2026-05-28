#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'hugo-apps', 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const DEST_DIR = path.join(ROOT, 'hugo', 'static', 'vendor', 'mediapipe');

const MODEL_URLS = {
  'face_landmarker.task':
    'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  'hand_landmarker.task':
    'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'
};

async function downloadIfMissing(name, url) {
  const dest = path.join(DEST_DIR, name);
  if (fs.existsSync(dest)) {
    console.log(`  skipped ${name} (already present)`);
    return;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Model fetch ${name} failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  console.log(`  downloaded ${name} (${buf.length} bytes)`);
}

// Explicit allowlist of @mediapipe/tasks-vision@0.10.35 runtime files.
// If a package upgrade adds or removes .js/.wasm files, the guard below throws
// so a human can evaluate before they ship to browsers.
const RUNTIME_FILES = [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
  'vision_wasm_module_internal.js',
  'vision_wasm_module_internal.wasm'
];

async function main() {
  fs.mkdirSync(DEST_DIR, { recursive: true });
  if (!fs.existsSync(SRC_DIR)) {
    throw new Error(`Missing ${SRC_DIR}. Run "cd hugo-apps && npm install" first.`);
  }

  // Guard: verify package contents exactly match RUNTIME_FILES
  const present = fs.readdirSync(SRC_DIR).filter(f => f.endsWith('.js') || f.endsWith('.wasm'));
  const unexpected = present.filter(f => !RUNTIME_FILES.includes(f));
  const missing = RUNTIME_FILES.filter(f => !present.includes(f));
  if (unexpected.length > 0) {
    throw new Error(
      `Unexpected file(s) in ${SRC_DIR}: ${unexpected.join(', ')}.\n` +
      `Add them to RUNTIME_FILES if legitimate, or update the @mediapipe/tasks-vision version.`
    );
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing expected file(s) in ${SRC_DIR}: ${missing.join(', ')}.\n` +
      `The @mediapipe/tasks-vision package may have removed them; update RUNTIME_FILES.`
    );
  }

  // Copy runtime files from the explicit allowlist
  for (const f of RUNTIME_FILES) {
    const src = path.join(SRC_DIR, f);
    fs.copyFileSync(src, path.join(DEST_DIR, f));
    console.log(`  copied ${f}`);
  }

  // Download model files if not already present
  for (const [name, url] of Object.entries(MODEL_URLS)) {
    await downloadIfMissing(name, url);
  }

  console.log('MediaPipe assets vendored to', DEST_DIR);
}

main().catch((err) => { console.error(err); process.exit(1); });
