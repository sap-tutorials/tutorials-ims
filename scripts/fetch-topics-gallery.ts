import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const OUT = join('hugo', 'data', 'topics_gallery.json');

export async function writeTopicsGallery(capBase = process.env.CAP_BASE_URL || 'http://localhost:4004') {
  let payload: any;
  try {
    const res = await fetch(`${capBase}/build/topics-gallery`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    payload = await res.json();
  } catch (err) {
    console.warn(`[fetch-topics-gallery] fail-open: ${(err as Error).message}`);
    payload = { gallery: [], clusters: {}, buildAt: new Date().toISOString(), error: 'fetch_failed' };
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(`[fetch-topics-gallery] wrote ${payload.gallery?.length ?? 0} cards -> ${OUT}`);
}

// CLI entry (tsx scripts/fetch-topics-gallery.ts)
if (import.meta.url === `file://${process.argv[1]}`) {
  writeTopicsGallery().catch(e => { console.error(e); process.exit(1); });
}
