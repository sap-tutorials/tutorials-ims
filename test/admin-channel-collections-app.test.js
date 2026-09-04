// test/admin-channel-collections-app.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const app = 'app/admin/channel-collections';

describe('channel-collections admin app', () => {
  it('has a manifest whose app id matches the folder camelName', () => {
    const m = JSON.parse(readFileSync(resolve(app, 'webapp/manifest.json'), 'utf8'));
    expect(m['sap.app'].id).toBe('sap.tutorials.admin.channelCollections');
    expect(m['sap.app'].dataSources.mainService.uri).toBe('/admin/');
  });
  it('targets the ChannelCollections entity on list + object pages', () => {
    const m = JSON.parse(readFileSync(resolve(app, 'webapp/manifest.json'), 'utf8'));
    const targets = m['sap.ui5'].routing.targets;
    const contextPaths = Object.values(targets).map((t) => t.options?.settings?.contextPath);
    expect(contextPaths).toContain('/ChannelCollections');
  });
  it('is registered in the admin-shell nav order and prefix map', () => {
    const src = readFileSync(resolve('app/admin-shell/scripts/admin-shell-overrides.js'), 'utf8');
    expect(src).toContain("'channel-collections'");
  });
  it('is listed in the shell navigation model', () => {
    const nav = readFileSync(resolve('app/admin-shell/webapp/model/navigation.json'), 'utf8');
    expect(nav).toContain('channelCollections');
  });
});
