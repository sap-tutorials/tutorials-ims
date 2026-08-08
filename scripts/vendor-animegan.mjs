// Vendors the AnimeGANv2 face_paint_512_v2 ONNX model for self-hosting (#1520).
//
// Source:  https://huggingface.co/akhaliq/AnimeGANv2-ONNX/resolve/main/face_paint_512_v2_0.onnx
// License: MIT  (upstream weights: bryandlee/animegan2-pytorch © 2021 Bryan Lee, MIT;
//                ONNX re-export by akhaliq inherits the MIT licence — no separate
//                licence file in the HF repo, but the source weights are MIT-licensed
//                and the export is a mechanical serialisation of those weights)
// SHA-256: 1381b17ed988e14a1f3cf8954d88073c0884ff4b70128ebe599f0d6021bca63e
//
// Runtime never fetches from a CDN — the model is served same-origin at
// /vendor/animegan/model.onnx (approuter CSP), exactly like the imgly assets.
//
// Idempotency: a .animegan-vendored-version sentinel records the model version;
// a version change (or a missing sentinel) wipes and re-fetches.

import { createHash } from 'crypto'
import { mkdir, readFile, writeFile, rm } from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const MODEL_URL = 'https://huggingface.co/akhaliq/AnimeGANv2-ONNX/resolve/main/face_paint_512_v2_0.onnx'
const EXPECTED_SHA256 = '1381b17ed988e14a1f3cf8954d88073c0884ff4b70128ebe599f0d6021bca63e'
const VERSION = 'face_paint_512_v2'
const DEST_DIR = path.resolve(ROOT, 'hugo/static/vendor/animegan')
const MODEL_PATH = path.join(DEST_DIR, 'model.onnx')
const SENTINEL = path.join(DEST_DIR, '.animegan-vendored-version')

async function sentinelMatches() {
  try {
    return (await readFile(SENTINEL, 'utf8')).trim() === VERSION
  } catch {
    return false
  }
}

async function main() {
  if (await sentinelMatches()) {
    console.log('animegan: up to date')
    return
  }

  console.log('animegan: fetching model ...')
  await rm(DEST_DIR, { recursive: true, force: true })
  await mkdir(DEST_DIR, { recursive: true })

  const res = await fetch(MODEL_URL, { redirect: 'follow' })
  if (!res.ok) throw new Error(`animegan fetch failed: ${res.status} ${res.statusText}`)

  const buf = Buffer.from(await res.arrayBuffer())
  const sha = createHash('sha256').update(buf).digest('hex')

  if (sha !== EXPECTED_SHA256) {
    throw new Error(
      `animegan SHA-256 mismatch\n  expected: ${EXPECTED_SHA256}\n  got:      ${sha}\n` +
      `Update EXPECTED_SHA256 in scripts/vendor-animegan.mjs after vetting the new file.`
    )
  }

  await writeFile(MODEL_PATH, buf)
  await writeFile(SENTINEL, VERSION + '\n')
  console.log(`animegan: vendored model.onnx (${(buf.length / 1e6).toFixed(1)} MB, sha256 verified)`)
}

main().catch((e) => { console.error(e); process.exit(1) })
