// test/unit/hugo/topics-layouts.test.ts
//
// Template-source assertions for the topics gallery + cluster-detail layouts.
// Pattern: readFileSync the layout source, assert on raw Go template text.
// Matches the established project pattern (see topic-clusters-band.test.ts).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const listSrc = readFileSync(
  path.resolve(import.meta.dirname, '../../../hugo/layouts/topics/list.html'),
  'utf-8',
);

const singleSrc = readFileSync(
  path.resolve(import.meta.dirname, '../../../hugo/layouts/topics/single.html'),
  'utf-8',
);

describe('topics/list.html — gallery page', () => {
  it('reads from site.Data.topics_gallery', () => {
    expect(listSrc).toContain('site.Data.topics_gallery');
  });

  it('has a card grid with .topics-gallery or .topics-card CSS class', () => {
    expect(listSrc).toMatch(/topics-gallery|topics-card/);
  });

  it('links cards to /topics/<slug>/', () => {
    expect(listSrc).toContain('/topics/');
  });

  it('guards the grid with an empty-state check on .gallery', () => {
    // Must have an `if` guard referencing gallery or its length
    expect(listSrc).toMatch(/if .*gallery/);
  });

  it('has id="topics-map" mount point for the map island', () => {
    expect(listSrc).toContain('id="topics-map"');
  });

  it('includes the topics-map island script unconditionally', () => {
    expect(listSrc).toContain('topics-map.js');
    // Must NOT be gated behind a {{ with site.Data.topics_map_bundle }} guard.
    expect(listSrc).not.toContain('topics_map_bundle');
  });

  it('has a search form pointing to /search/', () => {
    expect(listSrc).toContain('/search/');
  });

  it('shows concept chips from topConcepts', () => {
    expect(listSrc).toContain('topConcepts');
  });

  it('cross-links to /explore/ from the hero', () => {
    expect(listSrc).toContain('href="/explore/"');
  });
});

describe('topics/single.html — cluster detail page', () => {
  it('looks up cluster data from site.Data.topics_gallery.clusters', () => {
    expect(singleSrc).toContain('site.Data.topics_gallery.clusters');
  });

  it('guards render on $c (missing cluster data does not crash)', () => {
    expect(singleSrc).toMatch(/if \$c/);
  });

  it('switches heading and list type on orderMode', () => {
    expect(singleSrc).toContain('orderMode');
  });

  it('uses <ol> for path order mode', () => {
    expect(singleSrc).toContain('<ol');
  });

  it('uses <ul> for ranked order mode', () => {
    expect(singleSrc).toContain('<ul');
  });

  it('links concepts to /concepts/<slug>/', () => {
    expect(singleSrc).toContain('/concepts/');
  });

  it('has a peers section (connect)', () => {
    expect(singleSrc).toMatch(/peers|connect/i);
  });

  it('links peer clusters to /topics/<slug>/', () => {
    // peer links point back to /topics/
    expect(singleSrc).toMatch(/href="\/topics\/[^"]*"/);
  });

  it('has a breadcrumb with Home and Topics links', () => {
    expect(singleSrc).toContain('href="/"');
    expect(singleSrc).toContain('href="/topics/"');
  });

  it('has data-focus-cluster attribute for mini-map island', () => {
    expect(singleSrc).toContain('data-focus-cluster');
  });
});
