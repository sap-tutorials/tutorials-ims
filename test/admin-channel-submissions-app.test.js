import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p) => readFileSync(resolve(p), 'utf8');

describe('Channel Submissions admin app scaffold', () => {
  it('manifest points at /admin/ and the ChannelSubmissions contextPath', () => {
    const m = JSON.parse(read('app/admin/channel-submissions/webapp/manifest.json'));
    expect(m['sap.app'].id).toBe('sap.tutorials.admin.channelSubmissions');
    expect(m['sap.app'].dataSources.mainService.uri).toBe('/admin/');
    const list = m['sap.ui5'].routing.targets.ChannelSubmissionsList;
    expect(list.options.settings.contextPath).toBe('/ChannelSubmissions');
  });

  it('is registered in admin-shell overrides + navigation', () => {
    const overrides = read('app/admin-shell/scripts/admin-shell-overrides.js');
    expect(overrides).toContain('channel-submissions');
    expect(overrides).toContain("'csub'");
    const nav = read('app/admin-shell/webapp/model/navigation.json');
    expect(nav).toContain('channelSubmissions');
  });

  it('admin-shell manifest.json has the componentUsage, route, and target', () => {
    const shellManifest = JSON.parse(read('app/admin-shell/webapp/manifest.json'));
    expect(shellManifest['sap.ui5'].componentUsages.channelSubmissionsComponent).toBeDefined();
    const routes = shellManifest['sap.ui5'].routing.routes;
    const route = routes.find(r => r.name === 'channelSubmissions');
    expect(route).toBeDefined();
    expect(route.pattern).toBe('channel-submissions');
    const targets = shellManifest['sap.ui5'].routing.targets;
    expect(targets.channelSubmissionsTarget).toBeDefined();
  });

  it('Shell.controller.js contains the channelSubmissions nav key', () => {
    const controller = read('app/admin-shell/webapp/controller/Shell.controller.js');
    expect(controller).toContain('channelSubmissions');
  });
});
