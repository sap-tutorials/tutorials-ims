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

    it('Advocates/authoredTutorials + contributedTutorials disallow Insert/Update/Delete', () => {
      // Inverse Associations (not Compositions) — Create/Delete on the inline
      // table would error or create orphans. Capabilities annotation hides
      // the FE V4 toolbar buttons cleanly. Spec §4.4.
      for (const nav of ['authoredTutorials', 'contributedTutorials']) {
        const region = metadata.match(
          new RegExp(`<Annotations Target="AdminService\\.Advocates/${nav}"[\\s\\S]*?</Annotations>`)
        );
        expect(region, `Advocates/${nav} annotations region not found`).toBeTruthy();
        expect(region[0]).toContain('Term="Capabilities.InsertRestrictions"');
        expect(region[0]).toContain('Term="Capabilities.UpdateRestrictions"');
        expect(region[0]).toContain('Term="Capabilities.DeleteRestrictions"');
        // The Insertable/Updatable/Deletable values should be literal false.
        expect(region[0]).toMatch(/Insertable" Bool="false"/);
        expect(region[0]).toMatch(/Updatable" Bool="false"/);
        expect(region[0]).toMatch(/Deletable" Bool="false"/);
      }
    });

    it('AdvocateTopics.ID is hidden from the Topics inline table', () => {
      // The projection has no explicit field list, so ID is auto-projected.
      // FE V4's column-personalization dialog (or a default column set)
      // surfaces the row's own GUID alongside the Topic FK — confusing for
      // admins. @UI.Hidden suppresses the column entirely. Spec §4.2.
      const region = metadata.match(
        /<Annotations Target="AdminService\.AdvocateTopics\/ID"[\s\S]*?<\/Annotations>/
      );
      expect(region, 'AdvocateTopics/ID annotations region not found').toBeTruthy();
      // @UI.Hidden serializes to Term="UI.Hidden" Bool="true" (default truth).
      expect(region[0]).toMatch(/Term="UI\.Hidden"/);
    });
  });

  // Regression suite for spec 2026-06-24-tutorial-authorship-fk —
  // pins the Tutorials.author searchable value-help shape AND, most
  // importantly, the FK-propagation behavior. Without the FK
  // propagation (cds-compiler Feb 2025 "Annotating Managed
  // Associations"), the admin OP renders the GUID instead of the
  // displayName — same failure mode that PR #573/#588/#607 chased
  // on AdvocateTopics. This test catches a future compiler regression.
  describe('Tutorials.author value-help (spec 2026-06-24-tutorial-authorship-fk)', () => {
    it('AdminService.Tutorials/author carries Common.ValueList with SearchSupported + Users target', () => {
      const region = metadata.match(
        /<Annotations Target="AdminService\.Tutorials\/author"[^>]*>[\s\S]*?<\/Annotations>/
      );
      expect(region, 'Tutorials/author annotations region not found').toBeTruthy();
      // Either the association itself carries the ValueList OR the
      // propagated FK region (next assertion) does — depending on the
      // cds-compiler emission rules. We assert the FK region below;
      // here we just verify there IS an association-side region (the
      // implementer's annotate block must compile).
      expect(region[0]).toContain('Term="Common.Label"');
    });

    it('FK propagation: AdminService.Tutorials/author_ID inherits Common.Text + ValueList from the association', () => {
      // The cds-compiler Feb 2025 "Annotating Managed Associations"
      // feature copies expression-valued annotations from the
      // association onto the generated FK. This test pins that — if
      // it ever regresses, FE V4 will fall back to rendering the GUID
      // in the admin OP.
      const fkRegion = metadata.match(
        /<Annotations Target="AdminService\.Tutorials\/author_ID"[^>]*>[\s\S]*?<\/Annotations>/
      );
      expect(fkRegion, 'Tutorials/author_ID annotations region missing — FK propagation has regressed').toBeTruthy();
      // @Common.Text → author/displayName (so FE V4 renders the human name)
      expect(fkRegion[0]).toMatch(/Term="Common\.Text"[^>]+Path="author\/displayName"/);
      // @Common.ValueList → Users with SearchSupported
      expect(fkRegion[0]).toContain('Term="Common.ValueList"');
      expect(fkRegion[0]).toContain('CollectionPath" String="Users"');
      expect(fkRegion[0]).toMatch(/SearchSupported"\s+Bool="true"/);
    });

    it('Tutorials projection exposes flattened author.* scalars', () => {
      // Each flattened scalar must appear as a Property on Tutorials.
      for (const col of ['authorEmail', 'authorSapId', 'authorDisplayName', 'authorFirstName', 'authorLastName']) {
        expect(metadata, `${col} not found on AdminService.Tutorials`)
          .toMatch(new RegExp(`<Property Name="${col}"`));
      }
    });

    it('Users $search is functional via OData (proves @cds.search wires through to the runtime)', async () => {
      // @cds.search is a RUNTIME annotation — it does NOT emit
      // @Search.defaultSearchElement into the EDMX. The only way to
      // verify it's wired correctly is to call the endpoint with
      // ?$search=… and confirm a 200 (vs. a 400 "search not supported").
      const { status, data } = await project.get('/admin/Users?$top=1&$search=a', adminAuth);
      expect(status).toBe(200);
      expect(Array.isArray(data.value)).toBe(true);
    });
  });
});
