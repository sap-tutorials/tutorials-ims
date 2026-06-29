import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MANIFEST = JSON.parse(readFileSync(join(import.meta.dirname, '../../app/admin-shell/webapp/manifest.json'), 'utf8'));
const NAV = JSON.parse(readFileSync(join(import.meta.dirname, '../../app/admin-shell/webapp/model/navigation.json'), 'utf8'));

describe('admin-shell explainer-app registration (#759 PR 3b)', () => {
  it('manifest declares verbDefinitionsComponent and shelfDefinitionsComponent in componentUsages', () => {
    const usages = MANIFEST['sap.ui5']?.componentUsages || {};
    expect(usages.verbDefinitionsComponent?.name).toBe('sap.tutorials.admin.verbDefinitions');
    expect(usages.shelfDefinitionsComponent?.name).toBe('sap.tutorials.admin.shelfDefinitions');
  });

  it('manifest declares resourceRoots for both new apps', () => {
    const roots = MANIFEST['sap.ui5']?.resourceRoots || {};
    expect(roots['sap.tutorials.admin.verbDefinitions']).toBeTruthy();
    expect(roots['sap.tutorials.admin.shelfDefinitions']).toBeTruthy();
  });

  it('manifest routing has verbDefinitions and shelfDefinitions routes + targets', () => {
    const routes = MANIFEST['sap.ui5']?.routing?.routes || [];
    expect(routes.find(r => r.name === 'verbDefinitions')).toBeTruthy();
    expect(routes.find(r => r.name === 'shelfDefinitions')).toBeTruthy();
    const targets = MANIFEST['sap.ui5']?.routing?.targets || {};
    expect(targets['verbDefinitionsTarget']?.usage).toBe('verbDefinitionsComponent');
    expect(targets['shelfDefinitionsTarget']?.usage).toBe('shelfDefinitionsComponent');
  });

  it('navigation.json adds Verb Definitions + Shelf Definitions to the Content group', () => {
    const content = NAV.groups.find(g => g.title === 'Content' || g.key === 'content');
    expect(content).toBeTruthy();
    const items = content.items.map(i => i.key);
    expect(items).toContain('verbDefinitions');
    expect(items).toContain('shelfDefinitions');
  });

  it('Shell.controller.js NAV_KEY_TO_ROUTE + NAV_KEY_TO_TITLE include verbDefinitions + shelfDefinitions', () => {
    const SHELL = readFileSync(join(import.meta.dirname, '../../app/admin-shell/webapp/controller/Shell.controller.js'), 'utf8');
    // NAV_KEY_TO_ROUTE map should contain both new keys mapped to identical route names
    expect(SHELL).toMatch(/NAV_KEY_TO_ROUTE\s*=\s*\{[\s\S]+?verbDefinitions\s*:\s*["']verbDefinitions["']/);
    expect(SHELL).toMatch(/NAV_KEY_TO_ROUTE\s*=\s*\{[\s\S]+?shelfDefinitions\s*:\s*["']shelfDefinitions["']/);
    // NAV_KEY_TO_TITLE map should contain both keys
    expect(SHELL).toMatch(/NAV_KEY_TO_TITLE\s*=\s*\{[\s\S]+?verbDefinitions\s*:\s*["']Verb definitions["']/);
    expect(SHELL).toMatch(/NAV_KEY_TO_TITLE\s*=\s*\{[\s\S]+?shelfDefinitions\s*:\s*["']Shelf definitions["']/);
  });
});
