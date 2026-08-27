import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const CAP_BASE = process.env.CAP_BASE_URL || 'http://localhost:4004';
const OUT_PATH = join('hugo', 'data', 'tags.json');

async function main() {
  let payload = { tags: [] as string[], buildAt: new Date().toISOString(), error: null as string | null };
  try {
    const res = await fetch(`${CAP_BASE}/build/tags`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    payload = await res.json();
  } catch (err: any) {
    payload.error = err.message;
    console.warn(`[fetch-tags] WARN: ${err.message} — writing empty payload`);
  }
  mkdirSync(join('hugo', 'data'), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2), 'utf-8');
  console.log(`[fetch-tags] wrote ${payload.tags?.length ?? 0} tags to ${OUT_PATH}`);
}

main().catch(e => { console.error(e); process.exit(1); });
