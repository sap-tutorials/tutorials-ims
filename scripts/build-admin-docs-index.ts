import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const SOURCES = [
  'CLAUDE.md',
  'docs/content-pipeline.md',
  'docs/authentication-primer.md',
  'docs/authentication-architecture.md',
  'docs/mta-deployment.md',
  'docs/historic/hugo-migration.md',
  'docs/historic/ims-api-reference.md',
  'docs/historic/ims-uncovered-features.md',
  'docs/ias-migration-setup.md',
];
const OUT = 'srv/data/admin-docs-index.json';
const STOPWORDS = new Set(['the','and','for','with','this','that','from','are','was','were','use','using','can','will','not','but','have','has','had','its','our','your','their','they','them','also','more','than','then','here','there','what','when','where','which','who','whom','how','why','any','all','some','one','two','etc']);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || []).filter(t => !STOPWORDS.has(t));
}

function splitSections(md: string): Array<{ heading: string; body: string }> {
  const lines = md.split(/\r?\n/);
  const out: Array<{ heading: string; body: string }> = [];
  let current = { heading: 'Overview', body: [] as string[] };
  for (const line of lines) {
    const m = /^(#{2,3})\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (current.body.length || out.length === 0) out.push({ heading: current.heading, body: current.body.join('\n') });
      current = { heading: m[2], body: [] };
    } else {
      current.body.push(line);
    }
  }
  if (current.body.length) out.push({ heading: current.heading, body: current.body.join('\n') });
  return out.filter(s => s.body.trim().length > 30);
}

const docs: any[] = [];
for (const path of SOURCES) {
  let md: string;
  try { md = readFileSync(path, 'utf8'); }
  catch { console.warn(`[admin-docs-index] skip missing: ${path}`); continue; }
  const sections = splitSections(md);
  sections.forEach((s, i) => {
    docs.push({
      id: `${path}#${i}`,
      path,
      heading: s.heading,
      body: s.body.slice(0, 4000),
      headingTokens: tokenize(s.heading),
      bodyTokens: tokenize(s.body),
    });
  });
}

mkdirSync(dirname(resolve(OUT)), { recursive: true });
writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), docs }, null, 2));
console.log(`[admin-docs-index] wrote ${docs.length} sections to ${OUT}`);
