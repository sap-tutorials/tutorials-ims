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
