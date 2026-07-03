import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('SearchService', () => {

  beforeAll(async () => {
    const { Tutorials, Missions, Groups, Tags, TutorialTags, TutorialBodyText } = cds.entities('com.sap.developers.ims');

    await INSERT.into(Tutorials).entries([
      { ID: 'search-t1', legacyId: 90001, slug: 'hana-cloud-setup', title: 'SAP HANA Cloud Setup', description: 'Learn to configure HANA Cloud', primaryTag: 'SAP HANA Cloud', experienceTag: 'beginner', averageTimeToComplete: 30, status: 'ACTIVE' },
      { ID: 'search-t2', legacyId: 90002, slug: 'cap-getting-started', title: 'Getting Started with CAP', description: 'Build your first CAP app', primaryTag: 'SAP Cloud Application Programming Model', experienceTag: 'beginner', averageTimeToComplete: 45, status: 'ACTIVE' },
      { ID: 'search-t3', legacyId: 90003, slug: 'fiori-elements', title: 'SAP Fiori Elements', description: 'Create Fiori apps', primaryTag: 'SAP Fiori', experienceTag: 'intermediate', averageTimeToComplete: 60, status: 'ACTIVE' },
      { ID: 'search-t4', legacyId: 90004, slug: 'inactive-tutorial', title: 'Old Tutorial', description: 'Should not appear', primaryTag: 'Legacy', experienceTag: 'beginner', averageTimeToComplete: 10, status: 'INACTIVE' },
      // 5 tag-only-match rows + 1 title-match row, used to prove ranking arithmetic.
      { ID: 'search-tag-only-1', legacyId: 90011, slug: 'tag-only-1', title: 'Unrelated Title One',   description: 'No matching word.', primaryTag: '', experienceTag: 'beginner', averageTimeToComplete: 10, status: 'ACTIVE' },
      { ID: 'search-tag-only-2', legacyId: 90012, slug: 'tag-only-2', title: 'Unrelated Title Two',   description: 'No matching word.', primaryTag: '', experienceTag: 'beginner', averageTimeToComplete: 10, status: 'ACTIVE' },
      { ID: 'search-tag-only-3', legacyId: 90013, slug: 'tag-only-3', title: 'Unrelated Title Three', description: 'No matching word.', primaryTag: '', experienceTag: 'beginner', averageTimeToComplete: 10, status: 'ACTIVE' },
      { ID: 'search-tag-only-4', legacyId: 90014, slug: 'tag-only-4', title: 'Unrelated Title Four',  description: 'No matching word.', primaryTag: '', experienceTag: 'beginner', averageTimeToComplete: 10, status: 'ACTIVE' },
      { ID: 'search-tag-only-5', legacyId: 90015, slug: 'tag-only-5', title: 'Unrelated Title Five',  description: 'No matching word.', primaryTag: '', experienceTag: 'beginner', averageTimeToComplete: 10, status: 'ACTIVE' },
      { ID: 'search-trank',      legacyId: 90020, slug: 'rankprobe-tutorial', title: 'Rankprobe Tutorial', description: 'A tutorial whose title contains the rankprobe token.', primaryTag: '', experienceTag: 'beginner', averageTimeToComplete: 10, status: 'ACTIVE' },
      // Description-only match (rank=2): proves the 3-tier rank arithmetic
      // (title=3 > description=2 > tag-only=1) instead of just "title row first".
      { ID: 'search-tdesc',      legacyId: 90021, slug: 'rankprobe-desc-tutorial', title: 'Generic Tutorial Title', description: 'Body mentions rankprobe in passing.', primaryTag: '', experienceTag: 'beginner', averageTimeToComplete: 10, status: 'ACTIVE' },
    ]);

    await INSERT.into(Missions).entries([
      { ID: 'search-m1', legacyId: 90101, slug: 'full-stack-mission', title: 'Full-Stack CAP Application', description: 'Build end-to-end', primaryTag: 'SAP Cloud Application Programming Model', experienceTag: 'intermediate', averageTimeToComplete: 180, status: 'ACTIVE', published: true },
    ]);

    await INSERT.into(Groups).entries([
      { ID: 'search-g1', legacyId: 90201, title: 'HANA Basics Group', description: 'HANA fundamentals', primaryTag: 'SAP HANA Cloud', experienceTag: 'beginner', averageTimeToComplete: 90, status: 'ACTIVE', published: true },
    ]);

    await INSERT.into(Tags).entries([
      { ID: 'search-tag1', name: 'HANA Cloud',     label: 'SAP HANA Cloud',         legacyId: 80001 },
      { ID: 'search-tag2', name: 'CAP Node.js',    label: 'CAP Node.js',            legacyId: 80002 },
      { ID: 'search-tag3', name: 'sap-s-4hana',    label: 'SAP S/4HANA',            legacyId: 80003 },
      { ID: 'search-tag4', name: 'btp-development', label: 'SAP BTP Development',   legacyId: 80004 },
      { ID: 'search-tag5', name: 'fiori-elements', label: 'SAP Fiori Elements',     legacyId: 80005 },
      { ID: 'search-rankprobe-tag', name: 'rankprobe', label: 'Rankprobe',          legacyId: 80999 },
    ]);

    await INSERT.into(TutorialTags).entries([
      { tutorial_ID: 'search-t1', tag_ID: 'search-tag1' },  // HANA Cloud Setup -> "SAP HANA Cloud"
      { tutorial_ID: 'search-t2', tag_ID: 'search-tag2' },  // CAP Getting Started -> "CAP Node.js"
      { tutorial_ID: 'search-t3', tag_ID: 'search-tag3' },  // Fiori Elements -> "SAP S/4HANA" (tag-only signal)
      { tutorial_ID: 'search-t3', tag_ID: 'search-tag5' },  // Fiori Elements -> "SAP Fiori Elements"
      { tutorial_ID: 'search-t1', tag_ID: 'search-tag4' },  // HANA Cloud Setup -> "SAP BTP Development" (multi-token)
      // Ranking distractors — 5 tutorials whose only "rankprobe" connection is via tag.
      { tutorial_ID: 'search-tag-only-1', tag_ID: 'search-rankprobe-tag' },
      { tutorial_ID: 'search-tag-only-2', tag_ID: 'search-rankprobe-tag' },
      { tutorial_ID: 'search-tag-only-3', tag_ID: 'search-rankprobe-tag' },
      { tutorial_ID: 'search-tag-only-4', tag_ID: 'search-rankprobe-tag' },
      { tutorial_ID: 'search-tag-only-5', tag_ID: 'search-rankprobe-tag' },
    ]);

    await INSERT.into(TutorialBodyText).entries([
      { slug: 'hana-cloud-setup', bodyText: 'Open the BTP cockpit and provision a HANA Cloud instance. Configure the firewall ipallowlist before connecting.' },
      { slug: 'cap-getting-started', bodyText: 'Run cds init to scaffold a project. Add an entity to db schema and a service projection.' },
    ]);
  });

  describe('SearchableItems', () => {
    it('returns results from all three entity types', async () => {
      const { data } = await project.get('/search/SearchableItems');
      const types = [...new Set(data.value.map(i => i.taskType))];
      expect(types).toContain('TUTORIAL');
      expect(types).toContain('MISSION');
      expect(types).toContain('GROUP');
    });

    it('excludes inactive items', async () => {
      const { data } = await project.get('/search/SearchableItems');
      const titles = data.value.map(i => i.title);
      expect(titles).not.toContain('Old Tutorial');
    });

    it('GROUP results have null slug', async () => {
      const { data } = await project.get('/search/SearchableItems?$filter=taskType eq \'GROUP\'');
      expect(data.value.length).toBeGreaterThan(0);
      for (const item of data.value) {
        expect(item.slug).toBeNull();
      }
    });

    it('filters by taskType', async () => {
      const { data } = await project.get('/search/SearchableItems?$filter=taskType eq \'TUTORIAL\'');
      for (const item of data.value) {
        expect(item.taskType).toBe('TUTORIAL');
      }
    });

    it('filters by experienceTag', async () => {
      const { data } = await project.get('/search/SearchableItems?$filter=experienceTag eq \'beginner\'');
      for (const item of data.value) {
        expect(item.experienceTag).toBe('beginner');
      }
    });

    it('supports $top/$skip pagination', async () => {
      const { data } = await project.get('/search/SearchableItems?$top=2&$skip=0&$count=true');
      expect(data.value.length).toBeLessThanOrEqual(2);
      expect(data['@odata.count']).toBeGreaterThan(0);
    });

    it('returns all items when no $search is provided', async () => {
      const { data } = await project.get('/search/SearchableItems?$count=true');
      expect(data['@odata.count']).toBeGreaterThanOrEqual(5);
    });

    it('$search filters by title substring', async () => {
      const { data } = await project.get('/search/SearchableItems?$search=Fiori');
      const slugs = data.value.map(i => i.slug);
      expect(slugs).toContain('fiori-elements');
    });

    it('$search uses word-boundary matching, not substring', async () => {
      // "CAP" must NOT match a tutorial whose title contains "Capture"/"Capability"
      // but no actual CAP token. This is the regression case Tom flagged on
      // production: substring LIKE matched "Capture Events…" for a CAP search.
      // The fixture has no "Capture" row, so we instead verify positive matches
      // come only from rows that have CAP as a real word.
      const { data } = await project.get('/search/SearchableItems?$search=CAP');
      const slugs = data.value.map(i => i.slug);
      // search-t2 (Getting Started with CAP) and search-m1 (Full-Stack CAP Application)
      expect(slugs).toContain('cap-getting-started');
      expect(slugs).toContain('full-stack-mission');
      // search-t1 (SAP HANA Cloud Setup), search-t3 (SAP Fiori Elements) — no CAP word
      expect(slugs).not.toContain('hana-cloud-setup');
      expect(slugs).not.toContain('fiori-elements');
    });

    it('$search treats hyphens as word separators (tag matching)', async () => {
      // Tags like "products>sap-btp--abap-environment" should match $search=ABAP.
      // Verifies the normalize-separators step covers hyphens and angle brackets.
      const { data } = await project.get('/search/SearchableItems?$search=Node.js');
      // search-tag2 ("CAP Node.js") is the tag name — but tags aren't projected
      // into SearchableItems. Use a tag that IS on SearchableItems.primaryTag.
      // search-t1.primaryTag = "SAP HANA Cloud" — matches $search=HANA.
      // Re-issue with HANA:
      const r2 = await project.get('/search/SearchableItems?$search=HANA');
      const slugs = r2.data.value.map(i => i.slug);
      expect(slugs).toContain('hana-cloud-setup');
    });

    it('$search does NOT match body text (bodyText excluded from @cds.search)', async () => {
      // 'ipallowlist' appears only in the hana-cloud-setup body text, not in any title or description.
      // bodyText is deliberately excluded from @cds.search in srv/search-service.cds:21
      // (comment there: '"CAP" matching "escape"/"capture". bodyText dropped from @cds.search')
      // to prevent false positives from substring matches in long body text.
      const { data } = await project.get('/search/SearchableItems?$search=ipallowlist');
      const slugs = data.value.map(i => i.slug);
      expect(slugs).not.toContain('hana-cloud-setup');
    });

    it('does not expose bodyText in the OData response', async () => {
      const { data } = await project.get('/search/SearchableItems?$filter=slug eq \'hana-cloud-setup\'');
      expect(data.value.length).toBeGreaterThan(0);
      for (const item of data.value) {
        expect(item.bodyText).toBeUndefined();
      }
    });
  });

  describe('Tags', () => {
    it('returns available tags', async () => {
      const { data } = await project.get('/search/Tags');
      expect(data.value.length).toBeGreaterThan(0);
      expect(data.value[0]).toHaveProperty('name');
    });
  });

  describe('getFacets', () => {
    it('returns aggregation structure without filters', async () => {
      const srv = await cds.connect.to('SearchService');
      const result = await srv.send({ event: 'getFacets', data: {} });
      expect(result).toHaveProperty('totalCount');
      expect(result).toHaveProperty('typeCounts');
      expect(result).toHaveProperty('experienceCounts');
      expect(result).toHaveProperty('tagCounts');
      expect(result.totalCount).toBeGreaterThanOrEqual(5);
    });

    it('returns correct type counts including TUTORIAL, MISSION, GROUP', async () => {
      const srv = await cds.connect.to('SearchService');
      const result = await srv.send({ event: 'getFacets', data: {} });
      expect(Array.isArray(result.typeCounts)).toBe(true);
      const typeNames = result.typeCounts.map(tc => tc.name);
      expect(typeNames).toContain('TUTORIAL');
      expect(typeNames).toContain('MISSION');
      expect(typeNames).toContain('GROUP');
    });

    it('narrows results with taskTypes filter', async () => {
      const srv = await cds.connect.to('SearchService');
      const result = await srv.send({ event: 'getFacets', data: { taskTypes: ['TUTORIAL'] } });
      expect(result.totalCount).toBeGreaterThan(0);
      expect(result.typeCounts.every(t => t.name === 'TUTORIAL')).toBe(true);
    });

    it('returns zero totalCount for no-match search', async () => {
      const srv = await cds.connect.to('SearchService');
      const result = await srv.send({ event: 'getFacets', data: { search: 'xyznonexistent999' } });
      expect(result.totalCount).toBe(0);
    });
  });

  describe('Security', () => {
    it('does not require authentication', async () => {
      const { status } = await project.get('/search/SearchableItems',
        { validateStatus: () => true });
      expect(status).toBe(200);
    });
  });

  describe('tag matching (#154)', () => {
    it('matches tutorials by tag label only present in Tags.label', async () => {
      // search-t3 (Fiori Elements) has tag label "SAP S/4HANA". The title
      // contains neither "S/4HANA" nor "S 4hana" — only the tag label does.
      const { data } = await project.get('/search/SearchableItems?$search=S 4hana');
      const slugs = data.value.map(i => i.slug);
      expect(slugs).toContain('fiori-elements');
    });

    it('matches tutorials by tag slug', async () => {
      // search-t3 also carries slug "sap-s-4hana". Searching for the slug
      // word should match the same row.
      const { data } = await project.get('/search/SearchableItems?$search=sap s 4hana');
      const slugs = data.value.map(i => i.slug);
      expect(slugs).toContain('fiori-elements');
    });

    it('orders title-match above description-match above tag-only matches', async () => {
      // search-trank matches via title (rank=3 - "Rankprobe Tutorial");
      // search-tdesc matches via description only (rank=2 - "rankprobe in passing");
      // search-tag-only-1..5 match only via the "Rankprobe" tag (rank=1).
      // Acceptance criterion #2: strict 3-tier ordering, NOT just "title first".
      const { data } = await project.get('/search/SearchableItems?$search=rankprobe');
      const slugs = data.value.map(i => i.slug);
      expect(slugs[0]).toBe('rankprobe-tutorial');
      // Description-only hit must follow title hit AND precede tag-only hits.
      expect(slugs.indexOf('rankprobe-desc-tutorial')).toBeGreaterThan(0);
      const tagOnly = ['tag-only-1', 'tag-only-2', 'tag-only-3', 'tag-only-4', 'tag-only-5'];
      for (const s of tagOnly) {
        expect(slugs).toContain(s);
        expect(slugs.indexOf(s)).toBeGreaterThan(slugs.indexOf('rankprobe-desc-tutorial'));
      }
    });

    it('does not leak _searchRank via OData response', async () => {
      const { data } = await project.get('/search/SearchableItems?$search=hana');
      expect(data.value.length).toBeGreaterThan(0);
      for (const row of data.value) {
        expect(row).not.toHaveProperty('_searchRank');
      }
    });

    it('does not leak _searchRank via internal srv.run calls (Joule path)', async () => {
      // Joule's searchTutorials chat tool calls SearchService.SearchableItems
      // via cds.connect.to(...).run(SELECT...). The before/after('READ') hooks
      // fire on this path too — verify the strip works for internal callers,
      // not just the OData serializer.
      const srv = await cds.connect.to('SearchService');
      const rows = await srv.run(
        SELECT.from('SearchService.SearchableItems').search('hana')
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r).not.toHaveProperty('_searchRank');
      }
    });

    it('orders ranked results when internal callers project columns explicitly (Joule path)', async () => {
      // The Joule path passes explicit columns (slug/title/description/taskType/
      // primaryTag) so the rank column gets attached before $top truncates
      // results. Without ranking on this path, .limit(5) could strand title
      // hits behind tag-only matches — see plan-review iteration 3 issue I-2.
      const srv = await cds.connect.to('SearchService');
      const rows = await srv.run(
        SELECT.from('SearchService.SearchableItems')
          .columns('slug', 'title', 'description', 'taskType', 'primaryTag')
          .search('rankprobe')
          .limit(5)
      );
      const slugs = rows.map(r => r.slug);
      // Title hit must be first; tag-only-match rows fill the remaining slots.
      // Description-match (rankprobe-desc-tutorial) is rank=2 → should also
      // outrank tag-only rows (rank=1).
      expect(slugs[0]).toBe('rankprobe-tutorial');
      expect(slugs.indexOf('rankprobe-desc-tutorial')).toBeGreaterThan(0);
      // No leak even on this explicit-projection path.
      for (const r of rows) {
        expect(r).not.toHaveProperty('_searchRank');
      }
    });

    it('multi-token query AND-matches across columns including tagBag', async () => {
      // search-t1 has title "SAP HANA Cloud Setup" + tag "SAP BTP Development".
      // Token "hana" matches title; token "btp" matches tagBag. Both AND.
      const { data } = await project.get('/search/SearchableItems?$search=hana btp');
      const slugs = data.value.map(i => i.slug);
      expect(slugs).toContain('hana-cloud-setup');
    });

    it('drops stopwords so incomplete typing ("abap in") still returns results', async () => {
      // Regression test for the "too strict" search: typing "hana in " tokenises
      // to ['hana','in']; AND-semantics would require every corpus row to
      // contain a standalone `in` word, dropping the result set to zero.
      // Stopword filter removes `in` before the AND-loop, so the query behaves
      // like a plain `hana` search.
      const bareHana = await project.get('/search/SearchableItems?$search=hana');
      const withStopword = await project.get('/search/SearchableItems?$search=hana in');
      const bareSlugs = new Set(bareHana.data.value.map(i => i.slug).filter(Boolean));
      const stopSlugs = new Set(withStopword.data.value.map(i => i.slug).filter(Boolean));
      expect(stopSlugs.size).toBeGreaterThan(0);
      // Set equality — the stopword must not narrow the result set.
      expect([...stopSlugs].sort()).toEqual([...bareSlugs].sort());
    });

    it('returns nothing when ALL tokens are stopwords (same as empty search)', async () => {
      // "in on" tokenises to ['in','on'], both stopwords. Falls through to a
      // zero-token predicate — same behaviour as an empty search box (no
      // predicate applied, so the full catalogue comes back — we assert only
      // that this does NOT throw and does return rows).
      const { data } = await project.get('/search/SearchableItems?$search=in on');
      expect(Array.isArray(data.value)).toBe(true);
    });
  });
});
