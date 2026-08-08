// Generates six Devtoberfest-themed sticker PNGs (512x512, transparent bg)
// via hand-authored SVG + sharp rasterization.

import { createRequire } from 'module'
import { pathToFileURL } from 'url'
import { resolve } from 'path'
const require = createRequire(pathToFileURL(resolve(process.cwd(), 'package.json')).href)
const sharp = require('./node_modules/sharp/dist/index.cjs')
import { writeFile } from 'fs/promises'
import path from 'path'

const OUT = './hugo/static/images/devtoberfest/selfie/stickers'

// Devtoberfest palette
const OG = '#e8791a'   // orange
const DK = '#2b1a0f'   // dark brown
const GN = '#3d7a3a'   // pumpkin stem green
const WH = '#ffffff'
const BL = '#1c3c6e'   // SAP blue

function wrap(content) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">${content}</svg>`
}

// 5-pointed star path centred at cx,cy outer radius R, inner r
function starPath(cx, cy, R, r) {
  const pts = []
  for (let i = 0; i < 10; i++) {
    const angle = (Math.PI / 5) * i - Math.PI / 2
    const rad   = i % 2 === 0 ? R : r
    pts.push(`${(cx + rad * Math.cos(angle)).toFixed(1)},${(cy + rad * Math.sin(angle)).toFixed(1)}`)
  }
  return `M ${pts.join(' L ')} Z`
}

const SVGS = {

  pumpkin: wrap(`
    <rect x="238" y="40" width="36" height="70" rx="12" fill="${GN}"/>
    <rect x="258" y="40" width="28" height="55" rx="10" fill="${GN}"/>
    <ellipse cx="256" cy="300" rx="200" ry="185" fill="${OG}"/>
    <ellipse cx="256" cy="300" rx="135" ry="185" fill="none" stroke="${DK}" stroke-width="6"/>
    <line x1="256" y1="115" x2="256" y2="485" stroke="${DK}" stroke-width="6"/>
    <ellipse cx="180" cy="300" rx="90" ry="185" fill="none" stroke="${DK}" stroke-width="5" opacity="0.25"/>
    <ellipse cx="332" cy="300" rx="90" ry="185" fill="none" stroke="${DK}" stroke-width="5" opacity="0.25"/>
    <polygon points="170,240 210,175 250,240" fill="${DK}"/>
    <polygon points="262,240 302,175 342,240" fill="${DK}"/>
    <polygon points="240,285 256,255 272,285" fill="${DK}"/>
    <path d="M150,345 Q190,400 256,405 Q322,400 362,345" fill="${DK}"/>
    <rect x="175" y="345" width="32" height="28" rx="4" fill="${OG}"/>
    <rect x="224" y="355" width="32" height="38" rx="4" fill="${OG}"/>
    <rect x="278" y="355" width="32" height="38" rx="4" fill="${OG}"/>
    <rect x="327" y="345" width="32" height="28" rx="4" fill="${OG}"/>
  `),

  star: wrap(`
    <path d="${starPath(260, 260, 220, 88)}" fill="${DK}" opacity="0.18"/>
    <path d="${starPath(256, 254, 220, 88)}" fill="${OG}"/>
    <path d="${starPath(256, 254, 220, 88)}" fill="none" stroke="${WH}" stroke-width="8" opacity="0.35"/>
    <ellipse cx="210" cy="200" rx="38" ry="22" fill="${WH}" opacity="0.25" transform="rotate(-20 210 200)"/>
  `),

  'speech-bubble': wrap(`
    <rect x="40" y="60" width="420" height="310" rx="52" fill="${WH}" stroke="${OG}" stroke-width="16"/>
    <polygon points="100,360 80,460 220,360" fill="${WH}"/>
    <polygon points="88,374 66,462 208,374" fill="${OG}"/>
    <polygon points="100,360 80,460 220,360" fill="${WH}"/>
    <circle cx="158" cy="215" r="34" fill="${OG}"/>
    <circle cx="256" cy="215" r="34" fill="${OG}"/>
    <circle cx="354" cy="215" r="34" fill="${OG}"/>
  `),

  confetti: wrap(`
    <rect x="80"  y="60"  width="40" height="55" rx="6" fill="${OG}"  transform="rotate(-25 100 87)"/>
    <rect x="220" y="40"  width="38" height="52" rx="6" fill="#e040fb" transform="rotate(12 239 66)"/>
    <rect x="360" y="55"  width="36" height="50" rx="6" fill="#00bcd4" transform="rotate(-10 378 80)"/>
    <rect x="60"  y="200" width="42" height="30" rx="5" fill="#66bb6a" transform="rotate(35 81 215)"/>
    <rect x="190" y="170" width="38" height="28" rx="5" fill="${OG}"  transform="rotate(-18 209 184)"/>
    <rect x="330" y="155" width="40" height="32" rx="5" fill="#ef5350" transform="rotate(22 350 171)"/>
    <rect x="420" y="210" width="36" height="50" rx="6" fill="#ffd600" transform="rotate(-30 438 235)"/>
    <circle cx="150" cy="320" r="22" fill="#e040fb"/>
    <circle cx="256" cy="290" r="26" fill="${OG}"/>
    <circle cx="370" cy="310" r="20" fill="#00bcd4"/>
    <circle cx="90"  cy="390" r="18" fill="#ffd600"/>
    <circle cx="440" cy="360" r="22" fill="#66bb6a"/>
    <rect x="120" y="380" width="44" height="30" rx="5" fill="#ef5350" transform="rotate(15 142 395)"/>
    <rect x="260" y="370" width="40" height="28" rx="5" fill="${OG}"  transform="rotate(-20 280 384)"/>
    <rect x="370" y="400" width="38" height="32" rx="5" fill="#e040fb" transform="rotate(28 389 416)"/>
    <path d="${starPath(256, 200, 44, 18)}" fill="#ffd600"/>
    <path d="${starPath(130, 150, 32, 13)}" fill="${OG}"/>
    <path d="${starPath(390, 120, 36, 14)}" fill="#66bb6a"/>
    <path d="${starPath(460, 290, 28, 11)}" fill="#ef5350"/>
  `),

  'devtoberfest-badge': wrap(`
    <polygon points="256,30 452,140 452,372 256,482 60,372 60,140" fill="${DK}" opacity="0.18" transform="translate(6,6)"/>
    <polygon points="256,30 452,140 452,372 256,482 60,372 60,140" fill="${OG}"/>
    <polygon points="256,62 422,158 422,354 256,450 90,354 90,158" fill="none" stroke="${WH}" stroke-width="8" opacity="0.55"/>
    <text x="256" y="230" font-family="Arial Black, Arial, sans-serif" font-weight="900"
          font-size="120" fill="${WH}" text-anchor="middle" dominant-baseline="middle">DT</text>
    <text x="256" y="370" font-family="Arial, sans-serif" font-weight="700"
          font-size="38" fill="${DK}" text-anchor="middle" dominant-baseline="middle" letter-spacing="1">Devtoberfest</text>
    <path d="${starPath(256, 95, 28, 11)}" fill="${DK}" opacity="0.55"/>
  `),

  'sap-developers-lockup': wrap(`
    <rect x="56" y="140" width="400" height="120" rx="24" fill="${BL}"/>
    <text x="256" y="200" font-family="Arial Black, Arial, sans-serif" font-weight="900"
          font-size="80" fill="${WH}" text-anchor="middle" dominant-baseline="middle" letter-spacing="3">SAP</text>
    <rect x="56" y="270" width="400" height="76" rx="20" fill="${OG}"/>
    <text x="256" y="308" font-family="Arial, sans-serif" font-weight="700"
          font-size="40" fill="${WH}" text-anchor="middle" dominant-baseline="middle" letter-spacing="2">developers</text>
    <text x="82"  y="200" font-family="monospace" font-size="70" fill="${WH}" opacity="0.28">&lt;</text>
    <text x="392" y="200" font-family="monospace" font-size="70" fill="${WH}" opacity="0.28">/&gt;</text>
  `),
}

for (const [name, svg] of Object.entries(SVGS)) {
  const outPath = path.join(OUT, `${name}.png`)
  const buf = Buffer.from(svg)
  await sharp(buf, { density: 144 })
    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(outPath)
  console.log(`✓ ${name}.png`)
}
console.log('All 6 stickers generated.')
