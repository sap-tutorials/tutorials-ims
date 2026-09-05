import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CAP_BASE = process.env.CAP_BASE_URL || 'http://localhost:4004';
const OUT_PATH = join('hugo', 'data', 'channels-stats.json');

let payload: {
  total: number; publishedCount: number;
  byStatus: Record<string, number>; byOwnerType: Record<string, number>;
  byCategory: Record<string, number>; bySubcategory: Record<string, number>;
  sapVsCommunity: { sap: number; community: number };
  activeVsInactive: { active: number; inactive: number };
  buildAt: string; error: string | null;
} = {
  total: 0, publishedCount: 0,
  byStatus: {}, byOwnerType: {},
  byCategory: {}, bySubcategory: {},
  sapVsCommunity: { sap: 0, community: 0 },
  activeVsInactive: { active: 0, inactive: 0 },
  buildAt: new Date().toISOString(), error: null,
};

try {
  const res = await fetch(`${CAP_BASE}/build/channels-stats`);
  if (!res.ok) throw new Error(`status ${res.status}`);
  payload = { ...payload, ...(await res.json()) };
} catch (err) {
  payload.error = err instanceof Error ? err.message : String(err);
  console.warn(`[fetch-channels-stats] warn: ${payload.error} — writing empty payload`);
}

mkdirSync(join('hugo', 'data'), { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2), 'utf-8');
console.log(`[fetch-channels-stats] wrote stats (total=${payload.total}) → ${OUT_PATH}`);
