/**
 * Unit tests for CompletionPaths.pathOrder field.
 * Spec: issue #2990
 */
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

// Boot CDS to load the schema
cds.test('serve', '--project', '.', '--in-memory');

describe('CompletionPaths pathOrder field', () => {
  it('has an Integer pathOrder element', () => {
    const def = cds.model.definitions['com.sap.developers.ims.CompletionPaths'];
    expect(def).toBeDefined();
    expect(def.elements.pathOrder).toBeDefined();
    expect(def.elements.pathOrder.type).toBe('cds.Integer');
  });
});
