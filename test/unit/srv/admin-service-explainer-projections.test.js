import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CDS = readFileSync(join(import.meta.dirname, '../../../srv/admin-service.cds'), 'utf8');

describe('srv/admin-service.cds — explainer projections (issue #759 PR 1)', () => {
  it('exposes VerbDefinitions with @odata.draft.enabled', () => {
    // The projection also declares bound actions (`markReviewed`, `regenerate`),
    // so the head may be followed by either `;` or ` actions { ... }`.
    expect(CDS).toMatch(/@odata\.draft\.enabled\s*\n\s*entity\s+VerbDefinitions\s+as\s+projection\s+on\s+ims\.VerbDefinitions\b/);
  });
  it('exposes ShelfDefinitions with @odata.draft.enabled', () => {
    expect(CDS).toMatch(/@odata\.draft\.enabled\s*\n\s*entity\s+ShelfDefinitions\s+as\s+projection\s+on\s+ims\.ShelfDefinitions\b/);
  });
  it('VerbDefinitions explicitly opts out of change-tracking', () => {
    expect(CDS).toMatch(/@Capabilities\.ChangeTracking\s*:\s*\{\s*Supported:\s*false\s*\}\s*\n\s*@odata\.draft\.enabled\s*\n\s*entity\s+VerbDefinitions/);
  });
  it('ShelfDefinitions explicitly opts out of change-tracking', () => {
    expect(CDS).toMatch(/@Capabilities\.ChangeTracking\s*:\s*\{\s*Supported:\s*false\s*\}\s*\n\s*@odata\.draft\.enabled\s*\n\s*entity\s+ShelfDefinitions/);
  });
});
