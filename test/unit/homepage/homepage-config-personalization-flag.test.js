import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import cds from '@sap/cds';

describe('HomepageConfig.personalizationEnabled', () => {
  let model;
  beforeAll(async () => {
    model = await cds.load(['db/schema.cds', 'db/homepage.cds']);
  });

  it('exists as a Boolean default false', () => {
    const cfg = model.definitions['com.sap.developers.ims.HomepageConfig'];
    const el = cfg.elements.personalizationEnabled;
    expect(el).toBeDefined();
    expect(el.type).toBe('cds.Boolean');
    expect(el.default?.val).toBe(false);
  });

  // (#763 follow-up) Regression guard: without this line the admin
  // Object Page at /admin-ui/#homepageConfig renders the four legacy
  // fields but omits the master toggle, and the badge + For-You row
  // never appear on the homepage. The entity is writable through the
  // AdminService, but Fiori Elements only surfaces what's referenced
  // by @UI.FieldGroup.
  it('is included in AdminService.HomepageConfig UI.FieldGroup#Main', () => {
    const CDS = readFileSync(
      join(import.meta.dirname, '../../../app/admin-annotations.cds'),
      'utf8'
    );
    expect(CDS).toMatch(
      /annotate\s+AdminService\.HomepageConfig[\s\S]{0,2000}UI\.FieldGroup\s*#Main\s*:\s*\{\s*Data\s*:\s*\[[\s\S]{0,1200}Value\s*:\s*personalizationEnabled/
    );
  });
});
