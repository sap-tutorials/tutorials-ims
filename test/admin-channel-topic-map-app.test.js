import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p) => readFileSync(resolve(p), 'utf8');

describe('Channel Topic Map admin app scaffold', () => {
  it('manifest points at /admin/ and the ChannelTopicMap contextPath', () => {
    const m = JSON.parse(read('app/admin/channel-topic-map/webapp/manifest.json'));
    expect(m['sap.app'].id).toBe('sap.tutorials.admin.channelTopicMap');
    expect(m['sap.app'].dataSources.mainService.uri).toBe('/admin/');
    const list = m['sap.ui5'].routing.targets.ChannelTopicMapList;
    expect(list.options.settings.contextPath).toBe('/ChannelTopicMap');
  });

  it('is registered in admin-shell overrides + navigation', () => {
    const overrides = read('app/admin-shell/scripts/admin-shell-overrides.js');
    expect(overrides).toContain('channel-topic-map');
    expect(overrides).toContain("'ctm'");
    const nav = read('app/admin-shell/webapp/model/navigation.json');
    expect(nav).toContain('channelTopicMap');
  });
});
