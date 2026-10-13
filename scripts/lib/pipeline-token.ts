/**
 * #2727 — render-pipeline version token.
 *
 * Content change-detection selects slugs to publish by comparing each slug's
 * rendered-HTML hash against the server. That catches a changed render ONLY
 * once `hugo/public` has been rebuilt with the new output. A render-pipeline
 * token makes the dependency explicit the other way round: it is a single hash
 * over the *inputs* that determine how every slug renders — the parsers
 * (`scripts/parsers/**`), the Hugo templates/shortcodes (`hugo/layouts/**`),
 * and the CSS (`hugo/assets/css/**`). When any of those change, the token
 * changes, and the publish plan treats every slug as changed so a
 * parser/template/CSS-only fix can never be silently carried forward.
 *
 * Two layers:
 *   - `hashPipelineInputs(inputs)` — pure, no I/O. Hashes a sorted, length-
 *     delimited concatenation of (normalized path, content). Unit-testable.
 *   - `computePipelineToken({ root, patterns })` — globs + reads the tracked
 *     files under `root` and feeds them to `hashPipelineInputs`.
 */
import { createHash } from 'node:crypto';
import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PipelineInput {
  /** Repo-relative path. Separators are normalized so the token is stable cross-platform. */
  path: string;
  content: Buffer | string;
}

/**
 * Default glob set covering every input that affects rendered HTML but is NOT
 * a tutorial's own source markdown. Test files are excluded — editing a parser
 * test must not force a full content re-publish.
 */
export const DEFAULT_PIPELINE_PATTERNS: string[] = [
  'scripts/parsers/**/*.{ts,js,cjs,mjs}',
  'hugo/layouts/**/*.{html,xml,json}',
  'hugo/assets/css/**/*.css',
];

/** Globs excluded from DEFAULT_PIPELINE_PATTERNS matches (test sources). */
export const DEFAULT_PIPELINE_EXCLUDE: string[] = ['**/__tests__/**', '**/*.test.*', '**/*.spec.*'];

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Pure core: deterministic SHA-256 over the input set. Entries are sorted by
 * normalized path, then each is folded in as
 * `len(path)\0 path \0 len(content)\0 content` so neither path nor content
 * boundaries can be shifted into one another to forge a collision.
 */
export function hashPipelineInputs(inputs: PipelineInput[]): string {
  const normalized = inputs
    .map((i) => ({ path: normalizePath(i.path), content: Buffer.isBuffer(i.content) ? i.content : Buffer.from(i.content, 'utf8') }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const h = createHash('sha256');
  for (const { path, content } of normalized) {
    const pathBuf = Buffer.from(path, 'utf8');
    h.update(`${pathBuf.length}\0`);
    h.update(pathBuf);
    h.update(`\0${content.length}\0`);
    h.update(content);
  }
  return h.digest('hex');
}

/**
 * FS collector: glob the tracked files under `root` and hash them. An empty
 * match set is valid and yields a stable token (the hash of nothing), so a
 * misconfigured pattern degrades to "pipeline unchanged" rather than throwing
 * on a hot publish path.
 */
export function computePipelineToken(opts?: {
  root?: string;
  patterns?: string[];
  exclude?: string[];
}): string {
  const root = opts?.root ?? process.cwd();
  const patterns = opts?.patterns ?? DEFAULT_PIPELINE_PATTERNS;
  const exclude = opts?.exclude ?? DEFAULT_PIPELINE_EXCLUDE;

  const seen = new Set<string>();
  for (const pattern of patterns) {
    for (const match of globSync(pattern, { cwd: root, exclude })) {
      seen.add(normalizePath(match));
    }
  }

  const inputs: PipelineInput[] = [];
  for (const rel of seen) {
    inputs.push({ path: rel, content: readFileSync(join(root, rel)) });
  }
  return hashPipelineInputs(inputs);
}
