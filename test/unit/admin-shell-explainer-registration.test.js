import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MANIFEST = JSON.parse(readFileSync(join(import.meta.dirname, '../../app/admin-shell/webapp/manifest.json'), 'utf8'));
const NAV = JSON.parse(readFileSync(join(import.meta.dirname, '../../app/admin-shell/webapp/model/navigation.json'), 'utf8'));

describe('admin-shell explainer-app registration (#759 PR 3b)', () => {
  it('manifest declares verbDefinitionsComponent and shelfDefinitionsComponent in componentUsages', () => {
    const usages = MANIFEST['sap.ui5']?.componentUsages || {};
    expect(usages.verbDefinitionsComponent?.name).toBe('sap.tutorials.admin.verb-definitions');
    expect(usages.shelfDefinitionsComponent?.name).toBe('sap.tutorials.admin.shelf-definitions');
  });

  it('manifest declares resourceRoots for both new apps', () => {
    const roots = MANIFEST['sap.ui5']?.resourceRoots || {};
    expect(roots['sap.tutorials.admin.verb-definitions']).toBeTruthy();
    expect(roots['sap.tutorials.admin.shelf-definitions']).toBeTruthy();
  });

  it('manifest routing has verb-definitions and shelf-definitions routes + targets', () => {
    const routes = MANIFEST['sap.ui5']?.routing?.routes || [];
    expect(routes.find(r => r.name === 'verb-definitions')).toBeTruthy();
    expect(routes.find(r => r.name === 'shelf-definitions')).toBeTruthy();
    const targets = MANIFEST['sap.ui5']?.routing?.targets || {};
    expect(targets['verbDefinitionsTarget']?.usage).toBe('verbDefinitionsComponent');
    expect(targets['shelfDefinitionsTarget']?.usage).toBe('shelfDefinitionsComponent');
  });

  it('navigation.json adds Verb Definitions + Shelf Definitions to the Content group', () => {
    const content = NAV.groups.find(g => g.title === 'Content' || g.key === 'content');
    expect(content).toBeTruthy();
    const items = content.items.map(i => i.key);
    expect(items).toContain('verb-definitions');
    expect(items).toContain('shelf-definitions');
  });
});
