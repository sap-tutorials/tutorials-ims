// test/unit/check-cds-build-staging-namespace-filter.test.ts
//
// Unit tests for the namespace-only-drift filter added to
// scripts/check-cds-build-staging.ts after the 2026-06-21 #530 CI
// failure (and PR #524's own failure when it was merged). The filter
// strips the top-level `"namespace"` key from both CSN snapshots
// before comparing — that field is informational only and depends on
// non-deterministic compiler file-walk order.

import { describe, it, expect } from 'vitest';
// @ts-expect-error tsx imports the .ts source directly; vitest resolves it
import { isNamespaceOnlyDrift } from '../../scripts/check-cds-build-staging.ts';

describe('isNamespaceOnlyDrift()', () => {
  it('returns TRUE when only the top-level namespace differs', () => {
    const head = {
      namespace: 'com.sap.developers.ims',
      definitions: {
        'com.sap.developers.ims.Users': { kind: 'entity', elements: { ID: { type: 'cds.UUID' } } },
      },
    };
    const working = {
      namespace: 'com.sap.developers.ims.shared',  // <-- compiler picked a different one
      definitions: {
        'com.sap.developers.ims.Users': { kind: 'entity', elements: { ID: { type: 'cds.UUID' } } },
      },
    };
    expect(isNamespaceOnlyDrift(head, working)).toBe(true);
  });

  it('returns FALSE when an entity definition has actually changed', () => {
    const head = {
      namespace: 'com.sap.developers.ims',
      definitions: {
        'com.sap.developers.ims.Users': { kind: 'entity', elements: { ID: { type: 'cds.UUID' } } },
      },
    };
    const working = {
      namespace: 'com.sap.developers.ims',
      definitions: {
        'com.sap.developers.ims.Users': {
          kind: 'entity',
          elements: {
            ID: { type: 'cds.UUID' },
            newColumn: { type: 'cds.String', length: 100 },  // real change
          },
        },
      },
    };
    expect(isNamespaceOnlyDrift(head, working)).toBe(false);
  });

  it('returns FALSE when both namespace AND a definition changed (real schema change)', () => {
    // Defensive: a CSN diff that ALSO happens to flip the namespace must
    // not be silently swept under the rug just because the namespace key
    // is one of the changes.
    const head = {
      namespace: 'com.sap.developers.ims',
      definitions: {
        'com.sap.developers.ims.Users': { kind: 'entity', elements: { ID: { type: 'cds.UUID' } } },
      },
    };
    const working = {
      namespace: 'com.sap.developers.ims.shared',
      definitions: {
        'com.sap.developers.ims.Users': {
          kind: 'entity',
          elements: { ID: { type: 'cds.UUID' }, addedField: { type: 'cds.String' } },
        },
      },
    };
    expect(isNamespaceOnlyDrift(head, working)).toBe(false);
  });

  it('returns TRUE when both CSNs are identical (vacuous case)', () => {
    const csn = {
      namespace: 'com.sap.developers.ims',
      definitions: { 'foo': { kind: 'entity' } },
    };
    expect(isNamespaceOnlyDrift(csn, { ...csn })).toBe(true);
  });

  it('returns FALSE when either side is null / undefined / non-object', () => {
    expect(isNamespaceOnlyDrift(null, { namespace: 'a' })).toBe(false);
    expect(isNamespaceOnlyDrift({ namespace: 'a' }, null)).toBe(false);
    expect(isNamespaceOnlyDrift(undefined as any, undefined as any)).toBe(false);
    expect(isNamespaceOnlyDrift('a' as any, { namespace: 'a' })).toBe(false);
    expect(isNamespaceOnlyDrift({ namespace: 'a' }, 42 as any)).toBe(false);
  });

  it('does not mutate the caller objects (shallow-copy invariant)', () => {
    // The implementation deletes `.namespace` on each side; that MUST be
    // on a local copy, not the caller's object. Otherwise calling code
    // that wants to preserve the original CSN for error reporting would
    // see the field mysteriously gone.
    const head = { namespace: 'com.sap.developers.ims', definitions: { foo: {} } };
    const working = { namespace: 'com.sap.developers.ims.shared', definitions: { foo: {} } };
    isNamespaceOnlyDrift(head, working);
    expect(head.namespace).toBe('com.sap.developers.ims');
    expect(working.namespace).toBe('com.sap.developers.ims.shared');
  });

  it('handles deeply-nested definitions correctly (full JSON.stringify equality)', () => {
    // The compare uses JSON.stringify on the stripped copies. Locking the
    // contract that any difference beyond the top-level namespace fires.
    const head = {
      namespace: 'com.sap.developers.ims',
      definitions: {
        'Entity': {
          kind: 'entity',
          elements: {
            field1: { type: 'cds.String', '@assert.notNull': true, length: 100 },
          },
        },
      },
    };
    const working = {
      namespace: 'com.sap.developers.ims.shared',
      definitions: {
        'Entity': {
          kind: 'entity',
          elements: {
            field1: { type: 'cds.String', '@assert.notNull': false, length: 100 },  // flipped notNull
          },
        },
      },
    };
    expect(isNamespaceOnlyDrift(head, working)).toBe(false);
  });
});
