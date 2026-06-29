import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CDS = readFileSync(join(import.meta.dirname, '../../../srv/admin-service.cds'), 'utf8');

describe('srv/admin-service.cds — explainer projections (issue #759 PR 1)', () => {
  it('exposes VerbDefinitions with @odata.draft.enabled', () => {
    expect(CDS).toMatch(/@odata\.draft\.enabled\s*\n\s*entity\s+VerbDefinitions\s+as\s+projection\s+on\s+ims\.VerbDefinitions\s*;/);
  });
  it('exposes ShelfDefinitions with @odata.draft.enabled', () => {
    expect(CDS).toMatch(/@odata\.draft\.enabled\s*\n\s*entity\s+ShelfDefinitions\s+as\s+projection\s+on\s+ims\.ShelfDefinitions\s*;/);
  });
});
