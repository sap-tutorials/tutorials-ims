import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const CAP_BASE = process.env.CAP_BASE_URL || 'http://localhost:4004';
const OUT = resolve('hugo/data/channel-collections.json');

async function main() {
  let payload: Record<string, unknown> = { collections: [], buildAt: new Date().toISOString() };
  try {
    const res = await fetch(`${CAP_BASE}/build/channel-collections`);
    if (res.ok) payload = { ...payload, ...(await res.json()) };
    else payload.error = `HTTP ${res.status}`;
  } catch (e) {
    payload.error = String((e as Error).message || e);
  }
  mkdirSync(resolve('hugo/data'), { recursive: true });
  writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(`[fetch-channel-collections] wrote ${OUT} (${(payload.collections as unknown[]).length} collections)`);
}
main();
