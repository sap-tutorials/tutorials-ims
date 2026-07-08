import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const CAP_BASE = process.env.CAP_BASE_URL || 'http://localhost:4004';
const OUT_PATH = join('hugo', 'data', 'featured_topics.json');

async function main() {
  let payload = {
    computedAt: null as string | null,
    etag: '',
    snapshot: [] as unknown[],
    buildAt: new Date().toISOString(),
    error: null as string | null,
  };
  try {
    const res = await fetch(`${CAP_BASE}/build/featured-topics`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = await res.json();
    payload = { ...payload, ...body };
  } catch (err: any) {
    payload.error = err.message;
    console.warn(`[fetch-featured-topics] WARN: ${err.message} — writing empty payload`);
  }
  mkdirSync(join('hugo', 'data'), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2), 'utf-8');
  console.log(`[fetch-featured-topics] wrote ${payload.snapshot?.length ?? 0} slides to ${OUT_PATH}`);
}

main().catch(e => { console.error(e); process.exit(1); });
