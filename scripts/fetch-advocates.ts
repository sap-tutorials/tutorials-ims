/**
 * Build-time fetcher: pulls the advocates roster from CAP's /api/advocates,
 * renders each bio through markdown-it + sanitize-html, and emits one
 * hugo/content/developer-advocates/<slug>.md per active advocate.
 *
 * Wired into `npm run fetch-tutorials` so build:all + rebuild-content.yml
 * pick it up.
 *
 * Spec: docs/superpowers/specs/2026-06-27-601-advocate-profile-pages-design.md
 */
import { writeFileSync, readdirSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import MarkdownIt from 'markdown-it';
import sanitizeHtml from 'sanitize-html';
import { stringify as yamlStringify } from 'yaml';

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

// Sanitizer allowlist matches scripts/parsers/sanitize-html.ts SEMANTIC_TAGS
// minus the dangerous tags. We're sanitizing already-rendered HTML, so this
// list IS the security boundary.
const ALLOWED_TAGS = [
  'a', 'b', 'blockquote', 'br', 'code', 'dd', 'del', 'div', 'dl', 'dt',
  'em', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd',
  'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'small', 'span', 'strong',
  'sub', 'sup', 'u', 'ul',
];
const ALLOWED_ATTRS = {
  a: ['href', 'title', 'target', 'rel'],
  img: ['src', 'alt', 'title'],
};

function renderBio(markdown: string): { html: string; text: string } {
  const raw = String(markdown || '').trim();
  if (!raw) return { html: '', text: '' };
  const dirty = md.render(raw);
  const html = sanitizeHtml(dirty, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRS,
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener', target: '_blank' }),
    },
  });
  const sliced = sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, ' ').trim().slice(0, 200);
  // Drop a trailing lone high surrogate so we never split an emoji or
  // supplementary-plane char mid-character.
  const plain = /[\uD800-\uDBFF]$/.test(sliced) ? sliced.slice(0, -1) : sliced;
  return { html, text: plain };
}

function frontmatter(advocate: any): string {
  const { html, text } = renderBio(advocate.bio);
  const fm: Record<string, any> = {
    title: `${advocate.firstName} ${advocate.lastName}`,
    description: text,
    slug: advocate.slug,
    layout: 'single',
    type: 'developer-advocates',
    advocate: {
      firstName: advocate.firstName,
      lastName: advocate.lastName,
      title: advocate.title || '',
      pronouns: advocate.pronouns || '',
      location: advocate.location || '',
      region: advocate.region,
      hasPhoto: !!advocate.hasPhoto,
      photoUpdatedAt: advocate.photoUpdatedAt || '',
      joinedDate: advocate.joinedDate || '',
      topics: advocate.topics || [],
      links: advocate.links || [],
      bioHtml: html,
      bioText: text,
    },
  };
  return yamlStringify(fm);
}

export interface RunOpts {
  fetcher: () => Promise<{ advocates: any[] }>;
  contentDir: string;
  cacheDir: string;
}

export async function runFetchAdvocates({ fetcher, contentDir, cacheDir }: RunOpts): Promise<void> {
  mkdirSync(contentDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });

  const body = await fetcher();
  const roster = Array.isArray(body?.advocates) ? body.advocates : [];

  const sha = createHash('sha256').update(JSON.stringify(roster)).digest('hex');
  writeFileSync(join(cacheDir, 'advocates-roster.json'), JSON.stringify({ sha, roster }, null, 2));

  const active = roster.filter((a) => a.isActive !== false);
  const activeSlugs = new Set(active.map((a) => a.slug).filter(Boolean));

  for (const a of active) {
    if (!a.slug) continue;  // CAP /api/advocates contract guarantees slug, but be defensive at the build boundary
    const yaml = frontmatter(a);
    const out = `---\n${yaml}---\n`;
    writeFileSync(join(contentDir, `${a.slug}.md`), out);
  }

  for (const entry of readdirSync(contentDir)) {
    if (entry === '_index.md') continue;
    if (!entry.endsWith('.md')) continue;
    const slug = entry.replace(/\.md$/, '');
    if (!activeSlugs.has(slug)) {
      unlinkSync(join(contentDir, entry));
    }
  }
}

// CLI entry point — only runs when invoked directly via tsx.
// Robust check that works on Windows (file:///D:/... vs D:\...).
if (process.argv[1]?.endsWith('fetch-advocates.ts') || process.argv[1]?.endsWith('fetch-advocates.js')) {
  const CAP_BASE_URL = process.env.CAP_BASE_URL || 'http://localhost:4004';
  const repoRoot = process.cwd();
  const contentDir = join(repoRoot, 'hugo', 'content', 'developer-advocates');
  const cacheDir = join(repoRoot, '.tutorial-cache');

  const fetcher = async () => {
    const res = await fetch(`${CAP_BASE_URL}/api/advocates`);
    if (!res.ok) throw new Error(`fetch /api/advocates: ${res.status}`);
    return res.json();
  };

  runFetchAdvocates({ fetcher, contentDir, cacheDir })
    .then(() => console.log('[fetch-advocates] done'))
    .catch((err) => {
      console.error('[fetch-advocates] failed:', err);
      process.exit(1);
    });
}
