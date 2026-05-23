import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const FORBIDDEN = [
  'joule-step-help-fab',
  'chat-fab',
  'rating-indicator',
  'op-mark-complete',
  'profile-timeline',
  'progress-bar',
  'leaderboard'
];

export function findForbiddenMarkers(html: string): string[] {
  return FORBIDDEN.filter(m => html.includes(m));
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (e.endsWith('.html')) out.push(p);
  }
  return out;
}

function main() {
  const root = process.argv[2] ?? 'hugo/public-qa';
  if (!existsSync(root)) {
    console.error(`[verify-qa-build] directory not found: ${root}`);
    process.exit(1);
  }
  let bad = 0;
  for (const f of walk(root)) {
    const found = findForbiddenMarkers(readFileSync(f, 'utf8'));
    if (found.length) {
      console.error(`[verify-qa-build] ${f} contains: ${found.join(', ')}`);
      bad++;
    }
  }
  if (bad === 0) {
    console.log(`[verify-qa-build] clean — no forbidden markers in ${root}`);
  }
  process.exit(bad ? 1 : 0);
}

// Run CLI when executed directly
const isMain = process.argv[1]?.includes('verify-qa-build');
if (isMain) {
  main();
}
