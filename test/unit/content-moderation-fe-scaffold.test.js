import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const APP = join(process.cwd(), 'app', 'admin', 'content-moderation');

describe('#1034 content-moderation FE scaffold', () => {
  it('has package.json + ui5.yaml + Component.js + manifest.json', () => {
    for (const f of ['package.json', 'ui5.yaml', 'webapp/Component.js', 'webapp/manifest.json']) {
      expect(existsSync(join(APP, f)), `missing ${f}`).toBe(true);
    }
  });

  it('manifest declares component id sap.tutorials.admin.contentModeration', () => {
    const m = JSON.parse(readFileSync(join(APP, 'webapp', 'manifest.json'), 'utf8'));
    expect(m['sap.app'].id).toBe('sap.tutorials.admin.contentModeration');
  });

  it('manifest points OData model at /content-moderation', () => {
    const m = JSON.parse(readFileSync(join(APP, 'webapp', 'manifest.json'), 'utf8'));
    const modelUri = m['sap.app'].dataSources?.mainService?.uri
      ?? m['sap.ui5']?.models?.['']?.settings?.serviceUrl;
    expect(modelUri).toBe('/content-moderation/');
  });

  it('manifest defines routes for NewsItems list + object page', () => {
    const m = JSON.parse(readFileSync(join(APP, 'webapp', 'manifest.json'), 'utf8'));
    const routing = m['sap.ui5'].routing;
    const routeNames = routing.routes.map(r => r.name);
    expect(routeNames).toContain('NewsItemsList');
    expect(routeNames).toContain('NewsItemsObjectPage');
  });
});
