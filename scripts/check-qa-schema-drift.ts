import cds from '@sap/cds';
import { resolve } from 'node:path';

const ENTITIES = ['ContentFiles', 'ContentManifest', 'TutorialBodyText', 'RepoCatalog'];

export interface CompareResult {
  ok: true;
}

export interface DriftResult {
  ok: false;
  missing: string[];
  extra: string[];
  typeMismatch: string[];
}

export type ShapeResult = CompareResult | DriftResult;

export function compareEntityShape(name: string, prod: any, qa: any): ShapeResult {
  const prodCols = new Set(Object.keys(prod.elements ?? {}));
  const qaCols   = new Set(Object.keys(qa.elements ?? {}));
  const missing  = [...prodCols].filter(c => !qaCols.has(c));
  const extra    = [...qaCols].filter(c => !prodCols.has(c));
  const typeMismatch: string[] = [];
  for (const c of prodCols) {
    if (!qaCols.has(c)) continue;
    const p = prod.elements[c], q = qa.elements[c];
    if (p.type !== q.type || (p.length ?? null) !== (q.length ?? null)) {
      typeMismatch.push(`${c}: prod=${p.type}(${p.length ?? '-'}) qa=${q.type}(${q.length ?? '-'})`);
    }
  }
  if (missing.length === 0 && extra.length === 0 && typeMismatch.length === 0) {
    return { ok: true };
  }
  return { ok: false, missing, extra, typeMismatch };
}

async function main() {
  const root     = resolve(process.cwd());
  const prodPath = resolve(root, 'db/schema.cds');
  const qaPath   = resolve(root, 'db-qa/schema.cds');

  // cds.load resolves `using` imports (e.g. `using { managed } from '@sap/cds/common'`)
  // compile.to.csn on a raw string would not resolve external imports.
  const prodCsn = await cds.load([prodPath]);
  const qaCsn   = await cds.load([qaPath]);

  let drift = false;
  for (const e of ENTITIES) {
    const prod = (prodCsn.definitions as any)[`com.sap.developers.ims.${e}`];
    const qa   = (qaCsn.definitions as any)[`com.sap.developers.ims.qa.${e}`];
    if (!prod || !qa) {
      console.error(`[drift] missing entity ${e} (prod=${!!prod}, qa=${!!qa})`);
      drift = true;
      continue;
    }
    const r = compareEntityShape(e, prod, qa);
    if (!r.ok) {
      console.error(`[drift] ${e}:`, r);
      drift = true;
    } else {
      console.log(`[ok]    ${e}`);
    }
  }

  if (!drift) {
    console.log('Schema in sync — no drift detected.');
  }

  process.exit(drift ? 1 : 0);
}

// Run CLI when executed directly
const isMain = process.argv[1]?.includes('check-qa-schema-drift');
if (isMain) {
  main().catch(err => {
    console.error('Fatal:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
