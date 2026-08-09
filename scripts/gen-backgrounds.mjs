// Generates five Devtoberfest-themed selfie background scenes (1080x1080, opaque)
// via hand-authored SVG + sharp rasterization. Mirrors scripts/gen-stickers.mjs.
// Run from the repo root:  node scripts/gen-backgrounds.mjs

import { createRequire } from 'module'
import { pathToFileURL } from 'url'
import { resolve } from 'path'
const require = createRequire(pathToFileURL(resolve(process.cwd(), 'package.json')).href)
const sharp = require('./node_modules/sharp/dist/index.cjs')
import path from 'path'

const OUT = './hugo/static/images/devtoberfest/selfie/backgrounds'
const S = 1080

// Devtoberfest palette
const OG = '#e8791a'   // orange
const DK = '#2b1a0f'   // dark brown
const GN = '#3d7a3a'   // stem green
const WH = '#ffffff'
const BL = '#1c3c6e'   // SAP blue

function wrap(content) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">${content}</svg>`
}

// A simple round pumpkin at (cx,cy) radius r.
function pumpkin(cx, cy, r) {
  return `
    <ellipse cx="${cx}" cy="${cy}" rx="${r}" ry="${r * 0.9}" fill="${OG}"/>
    <ellipse cx="${cx}" cy="${cy}" rx="${r * 0.62}" ry="${r * 0.9}" fill="none" stroke="${DK}" stroke-width="3" opacity="0.4"/>
    <rect x="${cx - r * 0.08}" y="${cy - r * 1.1}" width="${r * 0.16}" height="${r * 0.28}" rx="6" fill="${GN}"/>`
}

const SVGS = {
  // Pumpkin patch: warm sky gradient, ground band, scattered pumpkins along the base.
  'pumpkin-patch': wrap(`
    <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffd9a0"/><stop offset="1" stop-color="${OG}"/>
    </linearGradient></defs>
    <rect width="${S}" height="${S}" fill="url(#sky)"/>
    <rect y="${S * 0.72}" width="${S}" height="${S * 0.28}" fill="${GN}"/>
    <rect y="${S * 0.72}" width="${S}" height="${S * 0.28}" fill="${DK}" opacity="0.15"/>
    ${pumpkin(150, S * 0.8, 90)}
    ${pumpkin(320, S * 0.86, 70)}
    ${pumpkin(S - 180, S * 0.82, 100)}
    ${pumpkin(S - 360, S * 0.88, 62)}`),

  // On stage: dark auditorium, spotlight cone, a bright stage floor + accent bar.
  'teched-stage': wrap(`
    <defs><radialGradient id="spot" cx="0.5" cy="0.1" r="0.9">
      <stop offset="0" stop-color="#3a4a63"/><stop offset="1" stop-color="#0b1220"/>
    </radialGradient></defs>
    <rect width="${S}" height="${S}" fill="url(#spot)"/>
    <polygon points="${S / 2},60 ${S * 0.22},${S * 0.78} ${S * 0.78},${S * 0.78}" fill="${WH}" opacity="0.08"/>
    <rect y="${S * 0.78}" width="${S}" height="${S * 0.22}" fill="#12203a"/>
    <rect y="${S * 0.78}" width="${S}" height="14" fill="${OG}"/>`),

  // Terminal: dark editor backdrop, prompt lines, a blinking-cursor block.
  terminal: wrap(`
    <rect width="${S}" height="${S}" fill="#0d1117"/>
    <rect x="0" y="0" width="${S}" height="70" fill="#161b22"/>
    <circle cx="40" cy="35" r="12" fill="#ff5f56"/><circle cx="76" cy="35" r="12" fill="#ffbd2e"/><circle cx="112" cy="35" r="12" fill="#27c93f"/>
    ${[0, 1, 2, 3, 4, 5].map((i) => `
      <text x="50" y="${170 + i * 90}" font-family="monospace" font-size="42" fill="${i % 2 ? '#8b949e' : GN}">$ ${i % 2 ? 'npm run build:all' : 'devtoberfest --join'}</text>`).join('')}
    <rect x="50" y="${170 + 6 * 90 - 34}" width="26" height="42" fill="${OG}"/>`),

  // Autumn: soft diagonal warm gradient with falling leaf marks.
  'autumn-gradient': wrap(`
    <defs><linearGradient id="au" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffcf8f"/><stop offset="0.5" stop-color="${OG}"/><stop offset="1" stop-color="#a8431a"/>
    </linearGradient></defs>
    <rect width="${S}" height="${S}" fill="url(#au)"/>
    ${[[180, 200], [900, 300], [500, 700], [820, 820], [260, 880], [640, 140]].map(([x, y]) => `
      <ellipse cx="${x}" cy="${y}" rx="34" ry="16" fill="${DK}" opacity="0.18" transform="rotate(35 ${x} ${y})"/>`).join('')}`),

  // Starfield: night sky, scattered stars, one large accent star.
  starfield: wrap(`
    <defs><radialGradient id="ng" cx="0.5" cy="0.4" r="0.8">
      <stop offset="0" stop-color="#1c2c52"/><stop offset="1" stop-color="#05070f"/>
    </radialGradient></defs>
    <rect width="${S}" height="${S}" fill="url(#ng)"/>
    ${Array.from({ length: 60 }, (_, i) => {
      const x = (i * 137) % S, y = (i * 251) % S, r = 1 + (i % 3)
      return `<circle cx="${x}" cy="${y}" r="${r}" fill="${WH}" opacity="${0.4 + (i % 4) * 0.15}"/>`
    }).join('')}
    <circle cx="${S - 220}" cy="220" r="60" fill="${OG}" opacity="0.9"/>
    <circle cx="${S - 220}" cy="220" r="60" fill="none" stroke="${WH}" stroke-width="4" opacity="0.4"/>`),
}

for (const [name, svg] of Object.entries(SVGS)) {
  const outPath = path.join(OUT, `${name}.png`)
  await sharp(Buffer.from(svg), { density: 144 })
    .resize(S, S, { fit: 'cover' })
    .png()
    .toFile(outPath)
  console.log(`✓ ${name}.png`)
}
console.log('All 5 backgrounds generated.')
