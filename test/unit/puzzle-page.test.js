import { describe, it, expect } from 'vitest';
import { gunzipSync } from 'node:zlib';
import {
  renderPuzzleBody,
  renderPuzzleNotFoundBody,
  createPuzzlePage,
  renderPuzzleIndexBody,
  createPuzzleIndex,
} from '../../srv/lib/puzzle-page.js';
import { parseShell } from '../../srv/lib/chrome-shell.js';

// Issue #1914 — puzzle solver pages are now served dynamically from CAP for
// any puzzle that exists in HANA (previously they were Hugo-static, so a
// puzzle created in the admin UI 404'd until a full rebuild). The handler
// composes the island-shell BODY into the __shell__ chrome via composeShell —
// the same path group/mission/concept pages use. Unit tests inject
// fetchPuzzle + shellLoader + getActiveVersion so no HANA / loaded model.

const SAMPLE_SHELL = `<!DOCTYPE html>
<html lang="en" data-page-kind="generic" data-page-slug="" data-page-title="">
<head><title></title><meta name="description" content=""></head>
<body><header>chrome</header>
<!-- MAIN -->
<footer>chrome-foot</footer></body></html>`;

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    ended: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(code) { this.statusCode = code; return this; },
    send(buf) { this.body = buf; return this; },
    end() { this.ended = true; return this; },
  };
}

function decode(res) {
  if (res.body == null) return '';
  if (res.headers['content-encoding'] === 'gzip') return gunzipSync(res.body).toString('utf-8');
  return String(res.body);
}

const okDeps = (puzzle) => ({
  fetchPuzzle: async () => puzzle,
  getActiveVersion: async () => 1,
  shellLoader: { get: async () => ({ ...parseShell(SAMPLE_SHELL), version: 1 }), invalidate() {} },
});

describe('renderPuzzleBody', () => {
  it('emits the puzzle-mount island node with slug + api + island script', () => {
    const body = renderPuzzleBody('devtoberfest-2026-warmup');
    expect(body).toContain('id="puzzle-mount"');
    expect(body).toContain('data-page-kind="puzzle"');
    expect(body).toContain('data-slug="devtoberfest-2026-warmup"');
    expect(body).toContain('data-api="/puzzle-api"');
    // Loads the built puzzle island (hashed path from the manifest, or the
    // /js/puzzle.js fallback when the manifest is absent).
    expect(body).toMatch(/<script type="module" src="[^"]*puzzle[^"]*\.js"[^>]*><\/script>/);
    expect(body).toContain('<noscript>');
  });

  it('HTML-escapes the slug so it cannot break out of the attribute', () => {
    const body = renderPuzzleBody('x" onload="alert(1)');
    expect(body).not.toContain('onload="alert(1)"');
    expect(body).toContain('&quot;');
  });
});

describe('renderPuzzleNotFoundBody', () => {
  it('renders a not-found message and does NOT load the puzzle island', () => {
    const body = renderPuzzleNotFoundBody('nope');
    expect(body.toLowerCase()).toContain('not found');
    expect(body).not.toContain('id="puzzle-mount"');
    expect(body).not.toMatch(/src="[^"]*puzzle[^"]*\.js"/);
  });

  it('escapes the slug', () => {
    const body = renderPuzzleNotFoundBody('<script>alert(1)</script>');
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('&lt;script&gt;');
  });
});

describe('createPuzzlePage handler', () => {
  it('serves 200 with the composed shell for an existing puzzle', async () => {
    const { puzzlePageHandler } = createPuzzlePage({
      deps: okDeps({ slug: 'devtoberfest-2026-warmup', title: 'Devtoberfest Warmup', description: 'Warm up', modifiedAt: '2026-08-19T00:00:00Z' }),
    });
    const res = fakeRes();
    await puzzlePageHandler({ params: { slug: 'devtoberfest-2026-warmup' }, headers: {} }, res);
    expect(res.statusCode).toBe(200);
    const html = decode(res);
    expect(html).toContain('id="puzzle-mount"');
    expect(html).toContain('data-slug="devtoberfest-2026-warmup"');
    expect(html).toContain('<title>Devtoberfest Warmup</title>');
    expect(html).toContain('<header>chrome</header>'); // shell chrome spliced in
  });

  it('serves 404 for a puzzle that is not in the backend', async () => {
    const { puzzlePageHandler } = createPuzzlePage({
      deps: { ...okDeps(null) },
    });
    const res = fakeRes();
    await puzzlePageHandler({ params: { slug: 'does-not-exist' }, headers: {} }, res);
    expect(res.statusCode).toBe(404);
    const html = decode(res);
    expect(html.toLowerCase()).toContain('not found');
    // Never long-cache a 404 (a puzzle may be created moments later).
    expect(String(res.getHeader('Cache-Control') || '')).not.toMatch(/s-maxage=600/);
  });

  it('looks up the slug case-insensitively (URLs are lowercase-canonical)', async () => {
    let seen;
    const { puzzlePageHandler } = createPuzzlePage({
      deps: {
        fetchPuzzle: async (slug) => { seen = slug; return { slug, title: 'T', description: '', modifiedAt: 'x' }; },
        getActiveVersion: async () => 1,
        shellLoader: { get: async () => ({ ...parseShell(SAMPLE_SHELL), version: 1 }), invalidate() {} },
      },
    });
    await puzzlePageHandler({ params: { slug: 'Devtoberfest-2026-Warmup' }, headers: {} }, fakeRes());
    expect(seen).toBe('devtoberfest-2026-warmup');
  });
});

// Follow-up (#1914): the /puzzles/ section index was 404. Serve it from CAP as
// a simple SSR card list of all puzzles, mirroring the concepts-index pattern.
describe('renderPuzzleIndexBody', () => {
  const PUZZLES = [
    { slug: 'devtoberfest-2026-warmup', title: 'Devtoberfest Warmup', description: 'Warm up for the fest.' },
    { slug: 'devtoberfest-cryptic-crossword', title: 'Cryptic Crossword', description: '' },
  ];

  it('renders a card per puzzle linking to /puzzles/<slug>/', () => {
    const body = renderPuzzleIndexBody(PUZZLES);
    expect(body).toContain('href="/puzzles/devtoberfest-2026-warmup/"');
    expect(body).toContain('Devtoberfest Warmup');
    expect(body).toContain('href="/puzzles/devtoberfest-cryptic-crossword/"');
    expect(body).toContain('Cryptic Crossword');
  });

  it('escapes puzzle titles/descriptions', () => {
    const body = renderPuzzleIndexBody([{ slug: 's', title: '<script>x</script>', description: '"q"' }]);
    expect(body).not.toContain('<script>x</script>');
    expect(body).toContain('&lt;script&gt;');
    expect(body).toContain('&quot;q&quot;');
  });

  it('renders an empty state when there are no puzzles', () => {
    const body = renderPuzzleIndexBody([]);
    expect(body.toLowerCase()).toContain('no puzzles');
    expect(body).not.toContain('href="/puzzles/');
  });
});

describe('createPuzzleIndex handler', () => {
  const okDeps = (puzzles) => ({
    fetchPuzzles: async () => puzzles,
    getActiveVersion: async () => 1,
    shellLoader: { get: async () => ({ ...parseShell(SAMPLE_SHELL), version: 1 }), invalidate() {} },
  });

  it('serves 200 with the composed shell listing puzzles', async () => {
    const { puzzleIndexHandler } = createPuzzleIndex({
      deps: okDeps([{ slug: 'a-puzzle', title: 'A Puzzle', description: 'd', modifiedAt: 'x' }]),
    });
    const res = fakeRes();
    await puzzleIndexHandler({ headers: {} }, res);
    expect(res.statusCode).toBe(200);
    const html = decode(res);
    expect(html).toContain('href="/puzzles/a-puzzle/"');
    expect(html).toContain('<title>Puzzles</title>');
    expect(html).toContain('<header>chrome</header>');
  });
});

