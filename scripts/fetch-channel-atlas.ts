// scripts/fetch-channel-atlas.ts
//
// Build-time fetch: calls GET /build/channel-atlas and writes the response to
// hugo/data/channel_atlas.json. The Hugo layout (hugo/layouts/channels/atlas.html)
// uses site.Data.channel_atlas to inject the payload as inline JSON so the SPA
// can read it without a network round-trip.
//
// Mirrors scripts/fetch-channels.ts.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const CAP_BASE = process.env.CAP_BASE_URL || 'http://localhost:4004'
const OUT_PATH = join('hugo', 'data', 'channel_atlas.json')

let payload: { channels: unknown[]; buildAt: string; error: string | null } = {
  channels: [],
  buildAt: new Date().toISOString(),
  error: null,
}

try {
  const res = await fetch(`${CAP_BASE}/build/channel-atlas`)
  if (!res.ok) throw new Error(`status ${res.status}`)
  payload = { ...payload, ...(await res.json()) }
} catch (err) {
  payload.error = err instanceof Error ? err.message : String(err)
  console.warn(`[fetch-channel-atlas] warn: ${payload.error} — writing empty payload`)
}

mkdirSync(join('hugo', 'data'), { recursive: true })
writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2), 'utf-8')
console.log(
  `[fetch-channel-atlas] wrote ${payload.channels.length} channels → ${OUT_PATH}`,
)
