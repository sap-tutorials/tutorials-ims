// test/unit/patch-draft-cascade-constraints.test.js
// Unit tests for the build-time cascade-constraint generator (#2993).
// No CDS boot — pure file-system fixture only.
//
// The generator emits a standalone *.hdbconstraint per draft table (NOT an
// inline FK in the .hdbtable — HDI rejects that, error 8250014).

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { patchDraftCascadeConstraints } from '../../scripts/patch-draft-cascade-constraints.cjs';

const FIXTURE_WITH_FK = `COLUMN TABLE AdminService_Missions_drafts (
  ID NVARCHAR(36) NOT NULL,
  IsActiveEntity BOOLEAN,
  HasActiveEntity BOOLEAN,
  HasDraftEntity BOOLEAN,
  DraftAdministrativeData_DraftUUID NVARCHAR(36) NOT NULL,
  PRIMARY KEY(ID)
)`;

const FIXTURE_WITHOUT_FK = `COLUMN TABLE AdminService_NoFk_drafts (
  ID NVARCHAR(36) NOT NULL,
  IsActiveEntity BOOLEAN,
  PRIMARY KEY(ID)
)`;

let tmp;
let emptyTmp;

const tablePath = (name) => path.join(tmp, name);
const read = (name) => fs.readFileSync(path.join(tmp, name), 'utf8');
const exists = (name) => fs.existsSync(path.join(tmp, name));

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-draft-test-'));
  emptyTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-draft-empty-'));
  fs.writeFileSync(tablePath('AdminService.Missions_drafts.hdbtable'), FIXTURE_WITH_FK, 'utf8');
  fs.writeFileSync(tablePath('AdminService.NoFk_drafts.hdbtable'), FIXTURE_WITHOUT_FK, 'utf8');
});

describe('patchDraftCascadeConstraints', () => {
  it('writes a sibling .hdbconstraint with the ON DELETE CASCADE FK', () => {
    const r = patchDraftCascadeConstraints(tmp);
    expect(exists('AdminService.Missions_drafts.hdbconstraint')).toBe(true);
    expect(r.patched).toContain('AdminService.Missions_drafts.hdbconstraint');

    const c = read('AdminService.Missions_drafts.hdbconstraint');
    // CONSTRAINT <name> / ON "<child>" FOREIGN KEY (...) / REFERENCES ... CASCADE
    expect(c).toMatch(/^CONSTRAINT\s+\S+/m);
    expect(c).toMatch(/ON\s+"AdminService_Missions_drafts"\s+FOREIGN KEY\s*\("DRAFTADMINISTRATIVEDATA_DRAFTUUID"\)/);
    expect(c).toMatch(/REFERENCES\s+"DRAFT_DRAFTADMINISTRATIVEDATA"\s*\("DRAFTUUID"\)\s+ON DELETE CASCADE/);
    // No ALTER TABLE / ADD CONSTRAINT verb — .hdbconstraint is the bare body.
    expect(c).not.toMatch(/ALTER\s+TABLE/i);
    expect(c).not.toMatch(/ADD\s+CONSTRAINT/i);
    // Quoted UPPERCASE column (HANA folds the bare declaration to upper).
    expect(c).not.toMatch(/"DraftAdministrativeData_DraftUUID"/);
  });

  it('leaves the .hdbtable completely untouched (HDI rejects inline FK)', () => {
    const before = read('AdminService.Missions_drafts.hdbtable');
    patchDraftCascadeConstraints(tmp);
    expect(read('AdminService.Missions_drafts.hdbtable')).toBe(before);
    expect(before).not.toMatch(/FOREIGN KEY/i);
  });

  it('skips draft tables without the FK column (no constraint file)', () => {
    patchDraftCascadeConstraints(tmp);
    expect(exists('AdminService.NoFk_drafts.hdbconstraint')).toBe(false);
  });

  it('is idempotent — second run rewrites identical content', () => {
    patchDraftCascadeConstraints(tmp);
    const first = read('AdminService.Missions_drafts.hdbconstraint');
    const r2 = patchDraftCascadeConstraints(tmp);
    expect(read('AdminService.Missions_drafts.hdbconstraint')).toBe(first);
    // Second run detects the identical artifact and skips the rewrite.
    expect(r2.skipped).toContain('AdminService.Missions_drafts.hdbtable');
  });

  it('throws when no draft tables are found', () => {
    expect(() => patchDraftCascadeConstraints(emptyTmp)).toThrow(/no .*_drafts\.hdbtable/i);
  });
});
