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

async function main() {
  fs.mkdirSync(DEST_DIR, { recursive: true });
  if (!fs.existsSync(SRC_DIR)) {
    throw new Error(`Missing ${SRC_DIR}. Run "cd hugo-apps && npm install" first.`);
  }

  // Copy all WASM runtime files from the package
  const wasmFiles = fs.readdirSync(SRC_DIR).filter(f => f.endsWith('.js') || f.endsWith('.wasm'));
  for (const f of wasmFiles) {
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
