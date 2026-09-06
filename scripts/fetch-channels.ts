import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CAP_BASE = process.env.CAP_BASE_URL || 'http://localhost:4004';
const OUT_PATH = join('hugo', 'data', 'channels.json');

let payload: { channels: unknown[]; buildAt: string; error: string | null } = {
  channels: [], buildAt: new Date().toISOString(), error: null,
};
try {
  const res = await fetch(`${CAP_BASE}/build/channels`);
  if (!res.ok) throw new Error(`status ${res.status}`);
  payload = { ...payload, ...(await res.json()) };
} catch (err) {
  payload.error = err instanceof Error ? err.message : String(err);
  console.warn(`[fetch-channels] warn: ${payload.error} — writing empty payload`);
}
mkdirSync(join('hugo', 'data'), { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2), 'utf-8');
console.log(`[fetch-channels] wrote ${payload.channels.length} channels → ${OUT_PATH}`);
