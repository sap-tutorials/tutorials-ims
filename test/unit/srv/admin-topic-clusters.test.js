// test/unit/srv/admin-topic-clusters.test.js
// Task 11 (#topics-discovery) — AdminService TopicClusters projection + actions.
//
// Guards:
//   (a) effectiveLabel falls back to label when curatedLabel is null,
//       and prefers curatedLabel when set.
//   (b) overrideTopicLabel sets curatedLabel on the underlying row.
//   (c) setTopicClusterHidden toggles the hidden flag.
//
// Auth pattern: admin.tx({ user: AUTHOR_USER }, tx => tx.send(...))
// — same pattern as AdminService.JobControls tests.
//
// Module-scope cds.test boot — same pattern as admin-job-controls.test.js.

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const NS = 'com.sap.developers.ims';

// Tutorial.Author satisfies @requires: 'Tutorial.Author' on the two actions.
// Admin is required for the service-level @requires: 'Admin' gate.
const AUTHOR_USER = { id: 'admin@test', roles: ['Admin', 'Tutorial.Author'] };

cds.test('serve', '--project', '.', '--in-memory');

describe('AdminService TopicClusters', () => {
  let admin;

  beforeAll(async () => {
    admin = await cds.connect.to('AdminService');
    const { TopicClusters } = cds.entities(NS);
    await INSERT.into(TopicClusters).entries([{
      slug: 'hana',
      label: 'HANA',
      curatedLabel: null,
      rationale: '',
      fingerprint: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      previousFingerprints: '',
      status: 'ACTIVE',
      hidden: false,
      memberCount: 1,
      tutorialCount: 1,
      computedAt: new Date().toISOString(),
    }]);
  });

  it('effectiveLabel falls back to label when curatedLabel is null', async () => {
    const rows = await admin.tx({ user: AUTHOR_USER }, (tx) =>
      tx.run(SELECT.from('AdminService.TopicClustersAdmin').where({ slug: 'hana' }))
    );
    expect(rows.length).toBe(1);
    expect(rows[0].effectiveLabel).toBe('HANA');
  });

  it('effectiveLabel prefers curatedLabel when set', async () => {
    const { TopicClusters } = cds.entities(NS);
    await UPDATE(TopicClusters).set({ curatedLabel: 'SAP HANA Cloud (curated)' }).where({ slug: 'hana' });
    const rows = await admin.tx({ user: AUTHOR_USER }, (tx) =>
      tx.run(SELECT.from('AdminService.TopicClustersAdmin').where({ slug: 'hana' }))
    );
    expect(rows[0].effectiveLabel).toBe('SAP HANA Cloud (curated)');
    // Reset for subsequent tests
    await UPDATE(TopicClusters).set({ curatedLabel: null }).where({ slug: 'hana' });
  });

  it('overrideTopicLabel sets curatedLabel', async () => {
    const result = await admin.tx({ user: AUTHOR_USER }, (tx) =>
      tx.send({ event: 'overrideTopicLabel', data: { slug: 'hana', label: 'SAP HANA Cloud' } })
    );
    expect(result).toBe(true);
    const { TopicClusters } = cds.entities(NS);
    const row = await SELECT.one.from(TopicClusters).where({ slug: 'hana' });
    expect(row.curatedLabel).toBe('SAP HANA Cloud');
  });

  it('setTopicClusterHidden toggles hidden to true', async () => {
    const result = await admin.tx({ user: AUTHOR_USER }, (tx) =>
      tx.send({ event: 'setTopicClusterHidden', data: { slug: 'hana', hidden: true } })
    );
    expect(result).toBe(true);
    const { TopicClusters } = cds.entities(NS);
    const row = await SELECT.one.from(TopicClusters).where({ slug: 'hana' });
    expect(row.hidden).toBe(true);
  });

  it('setTopicClusterHidden toggles hidden back to false', async () => {
    await admin.tx({ user: AUTHOR_USER }, (tx) =>
      tx.send({ event: 'setTopicClusterHidden', data: { slug: 'hana', hidden: false } })
    );
    const { TopicClusters } = cds.entities(NS);
    const row = await SELECT.one.from(TopicClusters).where({ slug: 'hana' });
    expect(row.hidden).toBe(false);
  });
});
