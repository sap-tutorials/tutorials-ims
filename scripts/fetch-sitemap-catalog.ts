import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Fetches the CAP catalog (GET /build/catalog) and flattens missions +
// their ordered tutorial lists into a Hugo data file consumed by the
// /sitemap.md template (layouts/_default/sitemapmd.md).
//
// Missions are NOT Hugo content pages — they are served dynamically from the
// CAP catalog — so this build-time fetch is the only way the static sitemap
// can enumerate them. Fail-open: when CAP_BASE_URL is absent (plain
// `build:hugo` / dev) or the fetch fails, we write an empty mission list and
// the template falls back to linking the /missions/ index, exactly like
// llms.txt does today.

const CAP_BASE = process.env.CAP_BASE_URL || 'http://localhost:4004';
const OUT_PATH = join('hugo', 'data', 'sitemap_catalog.json');

interface HierGroup { tutorialSlugs?: string[] }
interface Hierarchy { missionImsId: number; tutorialSlugs?: string[]; groups?: HierGroup[] }
interface Mission { imsId: number; slug: string; title: string; description: string; level: string; time: number }
interface Tutorial { slug: string; title: string }

async function main() {
  const payload: {
    missions: Array<Mission & { tutorials: Array<{ slug: string; title: string }> }>;
    buildAt: string;
    error: string | null;
  } = { missions: [], buildAt: new Date().toISOString(), error: null };

  try {
    const res = await fetch(`${CAP_BASE}/build/catalog`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const catalog = await res.json() as {
      missions?: Mission[];
      hierarchies?: Hierarchy[];
      tutorials?: Tutorial[];
    };

    const titleBySlug = new Map((catalog.tutorials ?? []).map(t => [t.slug, t.title || t.slug]));
    const hierByMission = new Map((catalog.hierarchies ?? []).map(h => [h.missionImsId, h]));

    payload.missions = (catalog.missions ?? []).map(m => {
      const h = hierByMission.get(m.imsId);
      // Flat missions carry tutorialSlugs at the top; grouped missions nest
      // them under groups[] — preserve the catalog's order in both cases.
      const orderedSlugs = h?.tutorialSlugs?.length
        ? h.tutorialSlugs
        : (h?.groups ?? []).flatMap(g => g.tutorialSlugs ?? []);
      return {
        imsId: m.imsId,
        slug: m.slug,
        title: m.title || m.slug,
        description: m.description || '',
        level: m.level || '',
        time: m.time || 0,
        tutorials: orderedSlugs.map(slug => ({ slug, title: titleBySlug.get(slug) || slug })),
      };
    });
  } catch (err: any) {
    payload.error = err.message;
    console.warn(`[fetch-sitemap-catalog] WARN: ${err.message} — writing empty payload`);
  }

  mkdirSync(join('hugo', 'data'), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2), 'utf-8');
  console.log(`[fetch-sitemap-catalog] wrote ${payload.missions.length} missions to ${OUT_PATH}`);
}

main().catch(e => { console.error(e); process.exit(1); });
