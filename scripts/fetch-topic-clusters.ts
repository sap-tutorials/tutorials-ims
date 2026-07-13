import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const CAP_BASE = process.env.CAP_BASE_URL || 'http://localhost:4004';
const OUT_PATH = join('hugo', 'data', 'topic_clusters.json');

async function main() {
  let payload = {
    clusters: [] as unknown[],
    buildAt: new Date().toISOString(),
    error: null as string | null,
  };
  try {
    const res = await fetch(`${CAP_BASE}/build/topic-clusters`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = await res.json();
    payload = { ...payload, ...body };
  } catch (err: any) {
    payload.error = err.message;
    console.warn(`[fetch-topic-clusters] WARN: ${err.message} — writing empty payload`);
  }
  mkdirSync(join('hugo', 'data'), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2), 'utf-8');
  console.log(`[fetch-topic-clusters] wrote ${payload.clusters?.length ?? 0} clusters to ${OUT_PATH}`);
}

main().catch(e => { console.error(e); process.exit(1); });
