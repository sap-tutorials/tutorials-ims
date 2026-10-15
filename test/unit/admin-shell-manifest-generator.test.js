// Unit tests for the admin-shell manifest generator (#1087).
//
// Adding a Fiori app under `app/admin/<name>/` requires a matching
// resourceRoot, componentUsage, route, and target inside the shell manifest.
// Historically these were hand-maintained mirrors of the folder scan;
// forgetting any one shipped a runtime 404 (#1086 videos / video-rotation /
// featured-topics, #639 homepage tile). The generator replaces those four
// mirrors with a scan-driven build step — these tests lock in the invariants.

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverComponents, toCamelCase } from '../../app/admin-shell/scripts/discover-admin-components.js';
import { buildBlocks } from '../../app/admin-shell/scripts/generate-manifest.js';

const REPO = process.cwd();
const MANIFEST = join(REPO, 'app', 'admin-shell', 'webapp', 'manifest.json');
const ADMIN = join(REPO, 'app', 'admin');

describe('admin-shell manifest generator (#1087)', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const { components } = discoverComponents(ADMIN);

  it('discovers every Fiori app under app/admin/', () => {
    expect(components.length).toBeGreaterThanOrEqual(30);
    // Sentinel apps that must always be present:
    const folders = components.map(c => c.folder);
    for (const required of ['tutorials', 'videos', 'video-rotation', 'featured-topics', 'homepage', 'content-moderation']) {
      expect(folders).toContain(required);
    }
  });

  it('folder camelCase must equal the last segment of sap.app.id', () => {
    for (const c of components) {
      expect(c.camelName).toBe(toCamelCase(c.folder));
    }
  });

  it('every discovered component has a resourceRoot entry', () => {
    const roots = manifest['sap.ui5'].resourceRoots;
    for (const c of components) {
      expect(roots[c.appId], `resourceRoot missing for ${c.folder}`)
        .toBe(`./components/${c.folder}`);
    }
  });

  it('every discovered component has a componentUsages entry', () => {
    const usages = manifest['sap.ui5'].componentUsages;
    // Match by target name (`name: <appId>`) rather than key — some entries
    // use a custom key (jouleSettingsComponent, devtoberfest, …).
    const appIds = new Set(Object.values(usages).map(u => u.name));
    for (const c of components) {
      expect(appIds.has(c.appId), `componentUsage missing for ${c.appId}`).toBe(true);
    }
  });

  it('every discovered component has at least one route + a component-type target', () => {
    const { routes, targets } = manifest['sap.ui5'].routing;
    // Every Component-type target must point at a known componentUsage.
    const usageKeys = new Set(Object.keys(manifest['sap.ui5'].componentUsages));
    const componentTargets = Object.entries(targets).filter(([, t]) => t.type === 'Component');
    for (const [name, t] of componentTargets) {
      expect(usageKeys.has(t.usage), `target ${name} references unknown usage ${t.usage}`).toBe(true);
    }
    // At least one route must reference each component target.
    const routedTargets = new Set();
    for (const r of routes) {
      if (Array.isArray(r.target)) {
        for (const t of r.target) routedTargets.add(t.name || t);
      } else if (typeof r.target === 'string') {
        routedTargets.add(r.target);
      }
    }
    for (const [name] of componentTargets) {
      expect(routedTargets.has(name), `no route references component target ${name}`).toBe(true);
    }
  });

  it('all route prefixes are unique (buildBlocks throws on collision)', () => {
    const prefixes = new Map();
    for (const [name, t] of Object.entries(manifest['sap.ui5'].routing.targets)) {
      if (t.prefix) {
        expect(prefixes.has(t.prefix), `prefix "${t.prefix}" reused by ${name} + ${prefixes.get(t.prefix)}`).toBe(false);
        prefixes.set(t.prefix, name);
      }
    }
  });

  it('buildBlocks throws on prefix collision', () => {
    // Force a collision by passing two records that both auto-derive the
    // same two-letter prefix and lack overrides.
    const collidingComponents = [
      { folder: 'test-a', appId: 'sap.tutorials.admin.testA', camelName: 'testA' },
      { folder: 'test-b', appId: 'sap.tutorials.admin.testB', camelName: 'testB' }
    ];
    expect(() => buildBlocks(collidingComponents)).toThrow(/prefix collision/i);
  });

  it('view-only targets in the template are preserved after generation', () => {
    const targets = manifest['sap.ui5'].routing.targets;
    for (const view of ['boardTarget', 'dashboardTarget', 'statisticsTarget', 'metricsTarget', 'dataExportTarget', 'privacyTarget', 'noAccessTarget', 'feedbackDashboardTarget']) {
      expect(targets[view], `view target ${view} missing from generated manifest`).toBeTruthy();
      expect(targets[view].viewName).toBeTruthy();
    }
  });
});

describe('toCamelCase', () => {
  it('converts kebab to camelCase', () => {
    expect(toCamelCase('video-rotation')).toBe('videoRotation');
    expect(toCamelCase('shelf-definitions')).toBe('shelfDefinitions');
    expect(toCamelCase('content-moderation')).toBe('contentModeration');
  });
  it('is idempotent for already-camelCase names', () => {
    expect(toCamelCase('videos')).toBe('videos');
    expect(toCamelCase('kgCommunities')).toBe('kgCommunities');
  });
});

// Guard: every real admin app under app/admin/ carries its own ui5.yaml.
// Without it, copy-components.js silently falls back from the preload build to
// a raw copy that ships NO Component-preload.js; a freestyle OData-V4 tile
// (app/admin/health) then dies at runtime with a "script load error"
// ModuleError on sap/ui/model/odata/v4/library.js. discoverComponents now fails
// the build the moment a non-excluded component lacks its ui5.yaml.
describe('ui5.yaml-presence guard', () => {
  it('every real admin component ships a ui5.yaml', () => {
    // Real tree must pass — if this fails, a tile is missing its ui5.yaml.
    expect(() => discoverComponents(ADMIN)).not.toThrow();
  });

  it('throws when a discovered component has no ui5.yaml', () => {
    const root = mkdtempSync(join(tmpdir(), 'admin-guard-'));
    try {
      const webapp = join(root, 'widget', 'webapp');
      mkdirSync(webapp, { recursive: true });
      writeFileSync(join(webapp, 'Component.js'), '// stub');
      writeFileSync(join(webapp, 'manifest.json'),
        JSON.stringify({ 'sap.app': { id: 'sap.tutorials.admin.widget' } }));
      // No ui5.yaml written → must throw.
      expect(() => discoverComponents(root)).toThrow(/missing ui5\.yaml/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exempts a component listed in the preload-exclude set', () => {
    const root = mkdtempSync(join(tmpdir(), 'admin-guard-'));
    try {
      const webapp = join(root, 'widget', 'webapp');
      mkdirSync(webapp, { recursive: true });
      writeFileSync(join(webapp, 'Component.js'), '// stub');
      writeFileSync(join(webapp, 'manifest.json'),
        JSON.stringify({ 'sap.app': { id: 'sap.tutorials.admin.widget' } }));
      const { components } = discoverComponents(root, new Set(['widget']));
      expect(components.map(c => c.folder)).toContain('widget');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
