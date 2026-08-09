import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('topicClusters admin manifest', () => {
  it('targets AdminService TopicClustersAdmin with LR + OP routes', () => {
    const m = JSON.parse(readFileSync('app/admin/topicClusters/webapp/manifest.json', 'utf-8'));
    expect(m['sap.app'].id).toBe('sap.tutorials.admin.topicClusters');
    expect(m['sap.app'].dataSources.mainService.uri).toBe('/admin/');
    const targets = m['sap.ui5'].routing.targets;
    const hasContextPath = JSON.stringify(targets).includes('/TopicClustersAdmin');
    expect(hasContextPath).toBe(true);
  });
});
