import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Issue #1914 follow-up — "the link in the admin screen should always point to
// the correct URL even after renaming." The dynamic /puzzles/<slug> route
// (#1914) makes any *current* slug resolve; this guard locks in that the admin
// Builder shows the link for the current SAVED slug (`b>/savedSlug`), refreshed
// on save, and NOT the editable `b>/slug` field (which would point at an
// unsaved slug that may not exist yet). A regression here would reintroduce the
// original "puzzle URL shows as missing" report.

const _dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(_dir, '..', '..');
const viewXml = readFileSync(join(repoRoot, 'app/admin/puzzles/webapp/view/Builder.view.xml'), 'utf8');
const controllerJs = readFileSync(join(repoRoot, 'app/admin/puzzles/webapp/controller/Builder.controller.js'), 'utf8');

describe('puzzle admin link points at the current saved slug (#1914)', () => {
  it('the displayed /puzzles/ Link binds href to savedSlug, not the editable slug', () => {
    // Isolate self-closing <Link .../> tags (UI5 expression bindings contain
    // '>' inside ${b>/path}, so match to the first '/>' rather than the first '>').
    const linkTags = (viewXml.match(/<Link\b[\s\S]*?\/>/g) || []).filter((t) => t.includes('/puzzles/'));
    expect(linkTags.length).toBeGreaterThan(0);
    for (const tag of linkTags) {
      expect(tag).toMatch(/savedSlug/);
      // Must not build the href straight from the editable /slug field.
      expect(tag).not.toMatch(/href="\{=\s*'\/puzzles\/'\s*\+\s*\$\{b>\/slug\}/);
    }
  });

  it('onCopyUrl builds the URL from savedSlug', () => {
    const m = controllerJs.match(/onCopyUrl:\s*function[\s\S]*?\}/);
    expect(m).toBeTruthy();
    expect(m[0]).toMatch(/savedSlug/);
  });

  it('onSave refreshes savedSlug from the activated puzzle (so the link tracks a rename)', () => {
    expect(controllerJs).toMatch(/setProperty\("\/savedSlug"/);
  });
});
