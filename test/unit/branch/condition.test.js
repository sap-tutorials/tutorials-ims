import { describe, it, expect } from 'vitest';
import { evalCondition, parseCondition, ConditionParseError } from '../../../srv/lib/branch/condition.js';

const EMPTY_STATE = Object.freeze({
  completedSlugs: new Set(),
  completedMissionSlugs: new Set(),
  profile: Object.freeze({ deployment: null, role: null, cloud: null })
});

const FULL_STATE = Object.freeze({
  completedSlugs: new Set(['node-getting-started', 'hana-intro']),
  completedMissionSlugs: new Set(['btp-cap-onboarding']),
  profile: Object.freeze({ deployment: 'cloud', role: 'developer', cloud: 'btp' })
});

describe('condition language — atoms', () => {
  it('completed: returns true when slug is in completedSlugs', () => {
    expect(evalCondition('completed:node-getting-started', FULL_STATE)).toBe(true);
  });
  it('completed: returns false when slug is missing', () => {
    expect(evalCondition('completed:other-slug', FULL_STATE)).toBe(false);
  });
  it('completedMission: returns true when mission slug is present', () => {
    expect(evalCondition('completedMission:btp-cap-onboarding', FULL_STATE)).toBe(true);
  });
  it("profile.field == 'value' returns true on match", () => {
    expect(evalCondition("profile.deployment == 'cloud'", FULL_STATE)).toBe(true);
  });
  it("profile.field == 'value' returns false on mismatch", () => {
    expect(evalCondition("profile.deployment == 'onprem'", FULL_STATE)).toBe(false);
  });
  it('profile.field in [...] returns true when value is in the list', () => {
    expect(evalCondition("profile.role in ['developer','architect']", FULL_STATE)).toBe(true);
  });
  it('profile.field in [...] returns false otherwise', () => {
    expect(evalCondition("profile.role in ['student']", FULL_STATE)).toBe(false);
  });
  it('true/false literals', () => {
    expect(evalCondition('true', EMPTY_STATE)).toBe(true);
    expect(evalCondition('false', EMPTY_STATE)).toBe(false);
  });
});

describe('condition language — connectives', () => {
  it('and (symbol) short-circuits', () => {
    expect(evalCondition("completed:node-getting-started && profile.deployment == 'cloud'", FULL_STATE)).toBe(true);
    expect(evalCondition("completed:missing && profile.deployment == 'cloud'", FULL_STATE)).toBe(false);
  });
  it('and (keyword) parses identically', () => {
    expect(evalCondition("completed:hana-intro and profile.role in ['developer']", FULL_STATE)).toBe(true);
  });
  it('negation flips a predicate', () => {
    expect(evalCondition('!completed:other-slug', FULL_STATE)).toBe(true);
    expect(evalCondition('!completed:hana-intro', FULL_STATE)).toBe(false);
  });
  it('parens group correctly', () => {
    expect(evalCondition("(profile.deployment == 'cloud' && completed:hana-intro)", FULL_STATE)).toBe(true);
  });
});

describe('condition language — errors', () => {
  it('throws ConditionParseError on missing slug', () => {
    expect(() => parseCondition('completed:')).toThrow(ConditionParseError);
  });
  it('throws on unknown predicate', () => {
    expect(() => parseCondition('foo:bar')).toThrow(ConditionParseError);
  });
  it('throws on unterminated string', () => {
    expect(() => parseCondition("profile.deployment == 'cloud")).toThrow(ConditionParseError);
  });
  it('throws on trailing input', () => {
    expect(() => parseCondition('true xxx')).toThrow(ConditionParseError);
  });
  it('throws on missing operator after profile field', () => {
    expect(() => parseCondition('profile.deployment')).toThrow(ConditionParseError);
  });
  it('non-string input is a parse error', () => {
    expect(() => parseCondition(42)).toThrow(ConditionParseError);
  });
});

describe('condition language — empty state (anonymous)', () => {
  it('all completed: returns false', () => {
    expect(evalCondition('completed:anything', EMPTY_STATE)).toBe(false);
  });
  it('all profile.* returns false', () => {
    expect(evalCondition("profile.deployment == 'cloud'", EMPTY_STATE)).toBe(false);
    expect(evalCondition("profile.role in ['student']", EMPTY_STATE)).toBe(false);
  });
});

describe('condition language — sandbox guarantees', () => {
  it('rejects strings that look like JS', () => {
    expect(() => parseCondition('1+1')).toThrow(ConditionParseError);
    expect(() => parseCondition("(()=>true)()")).toThrow(ConditionParseError);
  });
  it('rejects member-access syntax', () => {
    expect(() => parseCondition('foo.bar')).toThrow(ConditionParseError);
  });
});
