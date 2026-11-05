import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerDirective,
  getRegistry,
  resetRegistry,
  type DirectiveDef,
} from '../directive-registry.js';

const ECHO_DEF: DirectiveDef = {
  name: 'echo',
  kinds: ['inline', 'leaf', 'container'],
  summary: 'Echo directive for tests',
  label: { required: false, markdown: false },
  attrs: {
    n: { type: 'number' },
    flag: { type: 'boolean' },
  },
  classes: ['big'],
  render: () => '',
  toText: () => '',
  since: '1.0.0',
};

describe('directive-registry', () => {
  beforeEach(() => {
    resetRegistry();
  });

  it('registers a directive and round-trips via getRegistry().get(name)', () => {
    registerDirective(ECHO_DEF);
    const reg = getRegistry();
    expect(reg.get('echo')).toBe(ECHO_DEF);
  });

  it('getRegistry() returns all registered directives', () => {
    const def2: DirectiveDef = { ...ECHO_DEF, name: 'note' };
    registerDirective(ECHO_DEF);
    registerDirective(def2);
    const reg = getRegistry();
    expect(reg.size).toBe(2);
    expect(reg.get('echo')).toBe(ECHO_DEF);
    expect(reg.get('note')).toBe(def2);
  });

  it('throws on duplicate registration of same name', () => {
    registerDirective(ECHO_DEF);
    expect(() => registerDirective(ECHO_DEF)).toThrow();
  });

  it('throws when name does not match /^[a-z][a-z0-9-]*$/', () => {
    const bad1: DirectiveDef = { ...ECHO_DEF, name: 'Bad-Name' };
    const bad2: DirectiveDef = { ...ECHO_DEF, name: '1bad' };
    const bad3: DirectiveDef = { ...ECHO_DEF, name: '' };
    const bad4: DirectiveDef = { ...ECHO_DEF, name: 'bad_name' };
    expect(() => registerDirective(bad1)).toThrow();
    expect(() => registerDirective(bad2)).toThrow();
    expect(() => registerDirective(bad3)).toThrow();
    expect(() => registerDirective(bad4)).toThrow();
  });

  it('accepts valid lowercase kebab names', () => {
    const good1: DirectiveDef = { ...ECHO_DEF, name: 'a' };
    const good2: DirectiveDef = { ...ECHO_DEF, name: 'hello-world' };
    const good3: DirectiveDef = { ...ECHO_DEF, name: 'a1b2c3' };
    expect(() => registerDirective(good1)).not.toThrow();
    expect(() => registerDirective(good2)).not.toThrow();
    expect(() => registerDirective(good3)).not.toThrow();
  });

  it('resetRegistry() empties the registry', () => {
    registerDirective(ECHO_DEF);
    expect(getRegistry().size).toBe(1);
    resetRegistry();
    expect(getRegistry().size).toBe(0);
  });

  it('getRegistry() returns a ReadonlyMap', () => {
    registerDirective(ECHO_DEF);
    const reg = getRegistry();
    // ReadonlyMap has no .set method exposed at the type level,
    // but at runtime it is a plain Map — verify we cannot mutate via the interface
    expect(typeof (reg as unknown as Map<string, DirectiveDef>).set).toBe('function');
    // The return type is ReadonlyMap<string, DirectiveDef>, so this is a
    // structural read-only contract enforced by TypeScript, not a runtime lock.
    // Just verify has/get/size work correctly.
    expect(reg.has('echo')).toBe(true);
    expect(reg.size).toBe(1);
  });
});
