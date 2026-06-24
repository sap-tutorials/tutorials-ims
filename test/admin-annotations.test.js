// test/admin-annotations.test.js
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');
const adminAuth = { auth: { username: 'admin', password: 'admin' } };

describe('UI Annotations in $metadata', () => {
  let metadata;

  it('fetches metadata successfully', async () => {
    const { status, data } = await project.get('/admin/$metadata', adminAuth);
    expect(status).toBe(200);
    metadata = data;
  });

  describe('Events annotations', () => {
    it('has HeaderInfo annotation', () => {
      expect(metadata).toContain('UI.HeaderInfo');
    });

    it('has SelectionFields annotation', () => {
      expect(metadata).toContain('UI.SelectionFields');
    });

    it('has LineItem annotation', () => {
      expect(metadata).toContain('UI.LineItem');
    });
  });

  describe('Missions annotations', () => {
    it('has HeaderInfo for Missions', () => {
      expect(metadata).toContain('TypeName');
    });

    it('has ValueList annotation for primaryTagRef', () => {
      expect(metadata).toContain('Common.ValueList');
      expect(metadata).toContain('Tags');
    });
  });

  describe('Groups annotations', () => {
    it('has Groups LineItem annotation', () => {
      expect(metadata).toContain('Group');
    });
  });

  describe('Tutorials annotations', () => {
    it('has Tutorials LineItem annotation', () => {
      expect(metadata).toContain('Tutorial');
    });
  });

  // Regression suite for PR #604 — pins down the exact $metadata shape
  // that makes the Topic cell render text + offer value help and the
  // Kind cell render a fixed-values dropdown. Two prior PRs (#573 +
  // #586/#588) tried to fix the Topic GUID-instead-of-label bug and
  // failed because they bound LineItem to the navigation path
  // `tag.label` (unreadable without $expand, unwritable from the cell)
  // and patched the FK with a now-redundant `tag_ID @...` block that
  // the compiler silently dropped. This test fails loudly if either
  // mistake comes back.
  describe('Advocates inline tables (PR #604 regression)', () => {
    it('AdvocateTopics LineItem binds tag_ID, not tag/label', () => {
      const region = metadata.match(
        /<Annotations Target="AdminService\.AdvocateTopics">[\s\S]*?<\/Annotations>/
      );
      expect(region, 'AdvocateTopics annotations region not found').toBeTruthy();
      expect(region[0]).toContain('<Annotation Term="UI.LineItem">');
      expect(region[0]).toMatch(/Path="tag_ID"/);
      // The old (broken) shape bound to tag/label — explicitly reject it.
      expect(region[0]).not.toMatch(/Path="tag\/label"/);
    });

    it('AdvocateTopics/tag_ID inherits @Common.Text + ValueList from the tag association', () => {
      // The Feb 2025 cds-compiler "Annotating Managed Associations"
      // feature copies expression-valued annotations from the
      // association onto the generated FK. We rely on that
      // propagation — both Text (for display) and ValueList (for
      // value help) must reach the FK in the emitted EDMX.
      const fkRegion = metadata.match(
        /<Annotations Target="AdminService\.AdvocateTopics\/tag_ID">[\s\S]*?<\/Annotations>/
      );
      expect(fkRegion, 'AdvocateTopics/tag_ID annotations not found in $metadata').toBeTruthy();
      expect(fkRegion[0]).toMatch(/Term="Common\.Text"[^>]+Path="tag\/label"/);
      expect(fkRegion[0]).toContain('Term="Common.ValueList"');
      expect(fkRegion[0]).toContain('CollectionPath" String="Tags"');
    });

    it('AdvocateLinks/kind has a fixed-values value-help dropdown', () => {
      const kindRegion = metadata.match(
        /<Annotations Target="AdminService\.AdvocateLinks\/kind">[\s\S]*?<\/Annotations>/
      );
      expect(kindRegion, 'AdvocateLinks/kind annotations not found').toBeTruthy();
      expect(kindRegion[0]).toContain('Term="Common.ValueListWithFixedValues"');
      expect(kindRegion[0]).toContain('Term="Common.ValueList"');
      expect(kindRegion[0]).toContain('CollectionPath" String="AdvocateLinkKinds"');
    });

    it('AdvocateLinkKinds entity set is exposed and serves the enum codes', async () => {
      expect(metadata).toContain('Name="AdvocateLinkKinds"');
      const { status, data } = await project.get('/admin/AdvocateLinkKinds', adminAuth);
      expect(status).toBe(200);
      const codes = data.value.map(r => r.code).sort();
      expect(codes).toEqual([
        'Blog', 'BlueSky', 'Email', 'GitHub', 'LinkedIn', 'Mastodon',
        'Other', 'SapCommunity', 'X', 'YouTube',
      ].sort());
    });
  });
});
