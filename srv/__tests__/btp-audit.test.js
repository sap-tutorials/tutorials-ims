import { describe, it, expect } from 'vitest';
import {
  AUDIT_MAP, isCandidate, candidateRe, NS,
} from '../../scripts/btp-audit/fields.cjs';

describe('btp-audit fields map', () => {
  it('covers exactly the five in-scope entities with correct keys and fields', () => {
    const byEntity = Object.fromEntries(AUDIT_MAP.map(m => [m.entity, m]));
    expect(Object.keys(byEntity).sort()).toEqual([
      'HomepageFeaturedTopics', 'HomepageForYouCandidates',
      'HomepageShelves', 'ShelfDefinitions', 'VerbDefinitions',
    ]);
    expect(byEntity.HomepageShelves.keyField).toBe('ID');
    expect(byEntity.HomepageShelves.textFields).toEqual(
      ['title', 'description', 'tagline', 'whyItMatters']);
    expect(byEntity.VerbDefinitions.keyField).toBe('verbKey');
    expect(byEntity.ShelfDefinitions.keyField).toBe('shelfKey');
    expect(byEntity.HomepageFeaturedTopics.textFields).toEqual(
      ['displayTitle', 'notes']);
  });

  it('derives HANA table names as COM_SAP_DEVELOPERS_IMS_<ENTITY>', () => {
    const shelves = AUDIT_MAP.find(m => m.entity === 'HomepageShelves');
    expect(shelves.hanaTable).toBe('COM_SAP_DEVELOPERS_IMS_HOMEPAGESHELVES');
    expect(shelves.hanaKeyCol).toBe('ID');
    const verbs = AUDIT_MAP.find(m => m.entity === 'VerbDefinitions');
    expect(verbs.hanaKeyCol).toBe('VERBKEY');
  });

  it('isCandidate matches BTP variants case-insensitively, ignores non-strings', () => {
    expect(isCandidate('Deploy to SAP BTP today')).toBe(true);
    expect(isCandidate('the business technology platform')).toBe(true);
    expect(isCandidate('Use the btp CLI')).toBe(true);
    expect(isCandidate('Just plain tutorial text')).toBe(false);
    expect(isCandidate(null)).toBe(false);
    expect(isCandidate(42)).toBe(false);
  });

  it('candidateRe() returns a fresh non-global regex each call', () => {
    const a = candidateRe();
    const b = candidateRe();
    expect(a).not.toBe(b);
    expect(a.global).toBe(false);
    expect(NS).toBe('com.sap.developers.ims');
  });
});

import {
  buildMessages, parseClassification, VALID_ACTIONS,
} from '../../scripts/btp-audit/classify-core.cjs';

describe('btp-audit classification core', () => {
  const cand = { entity: 'HomepageShelves', key: 'abc', field: 'tagline',
                 value: 'Build on SAP BTP with the BTP Cockpit.' };

  it('buildMessages embeds the four rules and the field value', () => {
    const { system, user } = buildMessages(cand);
    expect(system).toMatch(/Business AI Platform/);
    expect(system).toMatch(/never.*BAIP/i);
    expect(system).toMatch(/BTP Cockpit/);
    expect(system).toMatch(/STRIP_PREFIX/);
    expect(system).toMatch(/NEEDS_REVIEW/);
    expect(user).toContain('Build on SAP BTP with the BTP Cockpit.');
    expect(user).toContain('HomepageShelves');
    expect(user).toContain('tagline');
  });

  it('parseClassification reads a well-formed REPLACE reply', () => {
    const raw = JSON.stringify({
      action: 'REPLACE',
      newValue: 'Build on SAP Business AI Platform with the BTP Cockpit.',
      rationale: 'Platform ref rewritten; tool name kept.',
    });
    const r = parseClassification(raw, cand);
    expect(r.action).toBe('REPLACE');
    expect(r.newValue).toMatch(/SAP Business AI Platform/);
    expect(r.oldValue).toBe(cand.value);
    expect(r.entity).toBe('HomepageShelves');
    expect(r.field).toBe('tagline');
    expect(r.key).toBe('abc');
  });

  it('parseClassification tolerates fenced ```json blocks', () => {
    const raw = '```json\n{"action":"KEEP","newValue":null,"rationale":"tool name"}\n```';
    const r = parseClassification(raw, cand);
    expect(r.action).toBe('KEEP');
    expect(r.newValue).toBeNull();
  });

  it('parseClassification fails safe to NEEDS_REVIEW on garbage', () => {
    const r = parseClassification('not json at all', cand);
    expect(r.action).toBe('NEEDS_REVIEW');
    expect(r.newValue).toBeNull();
    expect(r.rationale).toMatch(/parse/i);
  });

  it('parseClassification rejects an unknown action as NEEDS_REVIEW', () => {
    const raw = JSON.stringify({ action: 'DELETE_EVERYTHING', newValue: 'x' });
    const r = parseClassification(raw, cand);
    expect(r.action).toBe('NEEDS_REVIEW');
    expect(r.newValue).toBeNull();
  });

  it('parseClassification nulls newValue for KEEP/NEEDS_REVIEW even if model sent one', () => {
    const raw = JSON.stringify({ action: 'KEEP', newValue: 'should be ignored' });
    const r = parseClassification(raw, cand);
    expect(r.action).toBe('KEEP');
    expect(r.newValue).toBeNull();
  });

  it('exposes the four valid actions', () => {
    expect([...VALID_ACTIONS].sort()).toEqual(
      ['KEEP', 'NEEDS_REVIEW', 'REPLACE', 'STRIP_PREFIX']);
  });
});

import cds from '@sap/cds';
import { collectCandidates } from '../../scripts/btp-audit/export.cjs';

describe('btp-audit export.collectCandidates (in-memory sqlite)', () => {
  // reuse a single served instance for the DB-backed tests
  cds.test('serve', '--project', '.', '--in-memory');

  it('selects only fields containing BTP variants, one record per field', async () => {
    const db = await cds.connect.to('db');
    const ents = cds.entities('com.sap.developers.ims');
    const { HomepageShelves, VerbDefinitions } = ents;
    await DELETE.from(HomepageShelves).where({ ID: { in: ['s-btp', 's-clean'] } });
    await DELETE.from(VerbDefinitions).where({ verbKey: 'ZZTEST' });
    await INSERT.into(HomepageShelves).entries([
      { ID: 's-btp', verb: 'BUILD', shelf: 'TOOLS',
        title: 'Deploy to SAP BTP', description: 'nothing here',
        tagline: 'Use the BTP Cockpit', whyItMatters: 'plain text' },
      { ID: 's-clean', verb: 'LEARN', shelf: 'REFERENCE',
        title: 'Clean title', description: 'clean', tagline: 'clean', whyItMatters: 'clean' },
    ]);
    await INSERT.into(VerbDefinitions).entries([
      { verbKey: 'ZZTEST', label: 'Build', tagline: 'On Business Technology Platform',
        whyItMatters: 'clean' },
    ]);

    const found = await collectCandidates(db, ents);
    const mine = found.filter(c =>
      (c.entity === 'HomepageShelves' && ['s-btp', 's-clean'].includes(c.key)) ||
      (c.entity === 'VerbDefinitions' && c.key === 'ZZTEST'));

    // s-btp.title, s-btp.tagline, ZZTEST.tagline  => 3; s-clean => 0
    expect(mine.map(c => `${c.entity}.${c.key}.${c.field}`).sort()).toEqual([
      'HomepageShelves.s-btp.tagline',
      'HomepageShelves.s-btp.title',
      'VerbDefinitions.ZZTEST.tagline',
    ]);
    const title = mine.find(c => c.field === 'title');
    expect(title.value).toBe('Deploy to SAP BTP');

    await DELETE.from(HomepageShelves).where({ ID: { in: ['s-btp', 's-clean'] } });
    await DELETE.from(VerbDefinitions).where({ verbKey: 'ZZTEST' });
  });
});

import { classifyAll, renderReport, toChangeset } from '../../scripts/btp-audit/classify.cjs';

describe('btp-audit classify orchestration (fake LLM)', () => {
  const candidates = [
    { entity: 'HomepageShelves', key: 's1', field: 'title', value: 'Deploy to SAP BTP' },
    { entity: 'HomepageShelves', key: 's2', field: 'tagline', value: 'Open the BTP Cockpit' },
    { entity: 'VerbDefinitions', key: 'BUILD', field: 'tagline', value: 'SAP BTP, Kyma runtime' },
    { entity: 'HomepageShelves', key: 's3', field: 'description', value: 'Something BTP unclear' },
  ];
  // fake model keyed by field value
  const fake = async (_system, user) => {
    if (user.includes('Deploy to SAP BTP'))
      return JSON.stringify({ action: 'REPLACE', newValue: 'Deploy to SAP Business AI Platform', rationale: 'platform' });
    if (user.includes('BTP Cockpit'))
      return JSON.stringify({ action: 'KEEP', newValue: null, rationale: 'tool name' });
    if (user.includes('Kyma runtime'))
      return JSON.stringify({ action: 'STRIP_PREFIX', newValue: 'Kyma runtime', rationale: 'service prefix' });
    return 'garbage'; // → NEEDS_REVIEW
  };

  it('classifyAll maps each candidate via the injected LLM', async () => {
    const recs = await classifyAll(candidates, fake);
    expect(recs.map(r => r.action)).toEqual(['REPLACE', 'KEEP', 'STRIP_PREFIX', 'NEEDS_REVIEW']);
    expect(recs[0].newValue).toBe('Deploy to SAP Business AI Platform');
    expect(recs[2].newValue).toBe('Kyma runtime');
    expect(recs[3].newValue).toBeNull();
  });

  it('renderReport groups by action and surfaces NEEDS_REVIEW', async () => {
    const md = renderReport(await classifyAll(candidates, fake));
    expect(md).toMatch(/## REPLACE/);
    expect(md).toMatch(/## STRIP_PREFIX/);
    expect(md).toMatch(/## KEEP/);
    expect(md).toMatch(/## NEEDS_REVIEW/);
    expect(md).toMatch(/Deploy to SAP Business AI Platform/);
    expect(md).toMatch(/Something BTP unclear/);
  });

  it('toChangeset includes every record with its action', async () => {
    const cs = toChangeset(await classifyAll(candidates, fake));
    expect(cs.records).toHaveLength(4);
    expect(cs.records.every(r => r.entity && r.field && r.action)).toBe(true);
  });
});

import { decideApply, assertProdTarget } from '../../scripts/btp-audit/apply-core.cjs';

describe('btp-audit apply core', () => {
  const rec = { action: 'REPLACE', oldValue: 'Deploy to SAP BTP',
                newValue: 'Deploy to SAP Business AI Platform' };

  it('applies when current value still equals oldValue', () => {
    expect(decideApply(rec, 'Deploy to SAP BTP')).toEqual({ status: 'applied', write: true });
  });
  it('skips when the row was edited since export (concurrent edit)', () => {
    expect(decideApply(rec, 'Deploy to SAP BTP (edited)'))
      .toEqual({ status: 'skipped-concurrent-edit', write: false });
  });
  it('skips as no-change when already applied (idempotent re-run)', () => {
    expect(decideApply(rec, 'Deploy to SAP Business AI Platform'))
      .toEqual({ status: 'skipped-no-change', write: false });
  });
  it('skips KEEP and NEEDS_REVIEW actions', () => {
    expect(decideApply({ action: 'KEEP', oldValue: 'x', newValue: null }, 'x').write).toBe(false);
    expect(decideApply({ action: 'NEEDS_REVIEW', oldValue: 'x', newValue: null }, 'x').status)
      .toBe('skipped-action');
  });
  it('assertProdTarget throws unless org and space match', () => {
    const txt = 'org: tutorial-system\nspace: prod\napi endpoint: ...';
    expect(assertProdTarget(txt, { org: 'tutorial-system', space: 'prod' })).toBe(true);
    expect(() => assertProdTarget(txt, { org: 'tutorial-system', space: 'dev' })).toThrow(/space/i);
    expect(() => assertProdTarget('org: other\nspace: prod', { org: 'tutorial-system', space: 'prod' }))
      .toThrow(/org/i);
  });
});

import { applyChangeset } from '../../scripts/btp-audit/apply.cjs';

describe('btp-audit applyChangeset (in-memory sqlite)', () => {
  cds.test('serve', '--project', '.', '--in-memory');

  it('writes REPLACE on --commit, skips on dry-run, guards concurrent edits', async () => {
    const db = await cds.connect.to('db');
    const ents = cds.entities('com.sap.developers.ims');
    const { HomepageShelves } = ents;
    await DELETE.from(HomepageShelves).where({ ID: { in: ['a1', 'a2', 'a3'] } });
    await INSERT.into(HomepageShelves).entries([
      { ID: 'a1', verb: 'BUILD', shelf: 'TOOLS', title: 'Deploy to SAP BTP' },
      { ID: 'a2', verb: 'BUILD', shelf: 'TOOLS', title: 'Deploy to SAP BTP' }, // will be edited
      { ID: 'a3', verb: 'BUILD', shelf: 'TOOLS', title: 'Open BTP Cockpit' },  // KEEP
    ]);
    const records = [
      { entity: 'HomepageShelves', key: 'a1', field: 'title',
        oldValue: 'Deploy to SAP BTP', newValue: 'Deploy to SAP Business AI Platform', action: 'REPLACE' },
      { entity: 'HomepageShelves', key: 'a2', field: 'title',
        oldValue: 'Deploy to SAP BTP', newValue: 'Deploy to SAP Business AI Platform', action: 'REPLACE' },
      { entity: 'HomepageShelves', key: 'a3', field: 'title',
        oldValue: 'Open BTP Cockpit', newValue: null, action: 'KEEP' },
    ];

    // dry-run: nothing written
    const dry = await applyChangeset(db, ents, records, { commit: false });
    expect(dry.find(r => r.key === 'a1').status).toBe('would-apply');
    const a1dry = await SELECT.one.from(HomepageShelves).where({ ID: 'a1' });
    expect(a1dry.title).toBe('Deploy to SAP BTP'); // unchanged

    // simulate a concurrent edit to a2
    await UPDATE(HomepageShelves).set({ title: 'Deploy to SAP BTP (hand-edited)' }).where({ ID: 'a2' });

    // commit
    const log = await applyChangeset(db, ents, records, { commit: true });
    expect(log.find(r => r.key === 'a1').status).toBe('applied');
    expect(log.find(r => r.key === 'a2').status).toBe('skipped-concurrent-edit');
    expect(log.find(r => r.key === 'a3').status).toBe('skipped-action');

    const a1 = await SELECT.one.from(HomepageShelves).where({ ID: 'a1' });
    const a2 = await SELECT.one.from(HomepageShelves).where({ ID: 'a2' });
    expect(a1.title).toBe('Deploy to SAP Business AI Platform');
    expect(a2.title).toBe('Deploy to SAP BTP (hand-edited)'); // untouched

    await DELETE.from(HomepageShelves).where({ ID: { in: ['a1', 'a2', 'a3'] } });
  });

  it('rejects a record with a field name not in the AUDIT_MAP whitelist', async () => {
    const db = await cds.connect.to('db');
    const ents = cds.entities('com.sap.developers.ims');
    const { HomepageShelves } = ents;
    await DELETE.from(HomepageShelves).where({ ID: 'ax1' });
    await INSERT.into(HomepageShelves).entries([
      { ID: 'ax1', verb: 'BUILD', shelf: 'TOOLS', title: 'Deploy to SAP BTP' },
    ]);
    const records = [
      { entity: 'HomepageShelves', key: 'ax1', field: 'notAFieldInMap',
        oldValue: 'anything', newValue: 'injected', action: 'REPLACE' },
    ];
    const log = await applyChangeset(db, ents, records, { commit: true });
    expect(log[0].status).toBe('skipped-invalid-field');
    // confirm nothing was written
    const row = await SELECT.one.from(HomepageShelves).where({ ID: 'ax1' });
    expect(row.title).toBe('Deploy to SAP BTP');
    await DELETE.from(HomepageShelves).where({ ID: 'ax1' });
  });
});
