import { writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';

const OUT = join('hugo', 'data', 'topics_gallery.json');
const CONTENT_DIR = join('hugo', 'content', 'topics');
const INDEX_STUB = '_index.md';

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

  // Write per-cluster content stubs (Hugo needs a .md per cluster to bake detail pages)
  mkdirSync(CONTENT_DIR, { recursive: true });

  // Remove stale stubs (all *.md except _index.md)
  try {
    const existing = readdirSync(CONTENT_DIR);
    for (const f of existing) {
      if (f.endsWith('.md') && f !== INDEX_STUB) {
        unlinkSync(join(CONTENT_DIR, f));
      }
    }
  } catch {
    // CONTENT_DIR may not exist yet on very first run — mkdirSync above ensures it
  }

  // Write one stub per cluster
  const clusters = payload.clusters ?? {};
  for (const slug of Object.keys(clusters)) {
    const cluster = clusters[slug];
    const label = (cluster.label ?? slug).replace(/"/g, '\\"');
    const stub = [
      '---',
      `title: "${label}"`,
      `type: topics`,
      `layout: single`,
      `cluster: "${slug}"`,
      '---',
      '',
    ].join('\n');
    writeFileSync(join(CONTENT_DIR, `${slug}.md`), stub);
  }
  console.log(`[fetch-topics-gallery] wrote ${Object.keys(clusters).length} cluster stubs -> ${CONTENT_DIR}/`);
}

// CLI entry (tsx scripts/fetch-topics-gallery.ts)
if (import.meta.url === `file://${process.argv[1]}`) {
  writeTopicsGallery().catch(e => { console.error(e); process.exit(1); });
}
