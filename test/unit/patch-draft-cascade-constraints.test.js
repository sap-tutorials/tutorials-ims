// test/unit/patch-draft-cascade-constraints.test.js
// Unit tests for the build-time cascade-FK patch script (#2993).
// No CDS boot — pure file-system fixture only.

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { patchDraftCascadeConstraints } from '../../scripts/patch-draft-cascade-constraints.cjs';

// Minimal .hdbtable fixture that carries the FK column
const FIXTURE_WITH_FK = `COLUMN TABLE AdminService_Missions_drafts (
  ID NVARCHAR(36) NOT NULL,
  IsActiveEntity NVARCHAR(1),
  HasActiveEntity NVARCHAR(1),
  HasDraftEntity NVARCHAR(1),
  DraftAdministrativeData_DraftUUID NVARCHAR(36) NOT NULL,
  PRIMARY KEY(ID)
)`;

// Minimal .hdbtable fixture that does NOT carry the FK column
const FIXTURE_WITHOUT_FK = `COLUMN TABLE AdminService_NoFk_drafts (
  ID NVARCHAR(36) NOT NULL,
  IsActiveEntity NVARCHAR(1),
  PRIMARY KEY(ID)
)`;

let tmp;
let emptyTmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-draft-test-'));
  emptyTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-draft-empty-'));

  fs.writeFileSync(
    path.join(tmp, 'AdminService.Missions_drafts.hdbtable'),
    FIXTURE_WITH_FK,
    { encoding: 'utf8' }
  );
  fs.writeFileSync(
    path.join(tmp, 'AdminService.NoFk_drafts.hdbtable'),
    FIXTURE_WITHOUT_FK,
    { encoding: 'utf8' }
  );
});

describe('patchDraftCascadeConstraints', () => {
  it('appends ON DELETE CASCADE FK to draft tables that carry the FK column', () => {
    const r = patchDraftCascadeConstraints(tmp);
    const sql = fs.readFileSync(path.join(tmp, 'AdminService.Missions_drafts.hdbtable'), 'utf8');
    // Local column must be quoted UPPERCASE (HANA folds bare column names to upper).
    // A mixed-case quoted reference ("DraftAdministrativeData_DraftUUID") would be
    // case-sensitive and fail to resolve against the stored UPPERCASE name.
    expect(sql).toMatch(
      /FOREIGN KEY\s*\("DRAFTADMINISTRATIVEDATA_DRAFTUUID"\)\s*REFERENCES\s+"DRAFT_DRAFTADMINISTRATIVEDATA"\("DRAFTUUID"\)\s+ON DELETE CASCADE/
    );
    // Regression guard: must NOT emit the mixed-case quoted form.
    expect(sql).not.toMatch(/FOREIGN KEY\s*\("DraftAdministrativeData_DraftUUID"\)/);
    expect(r.patched).toContain('AdminService.Missions_drafts.hdbtable');
  });

  it('comma trails the previous line — no leading-comma style', () => {
    patchDraftCascadeConstraints(tmp);
    const sql = fs.readFileSync(path.join(tmp, 'AdminService.Missions_drafts.hdbtable'), 'utf8');
    // The separator comma must be attached to PRIMARY KEY(ID), not on its own line.
    expect(sql).toMatch(/PRIMARY KEY\(ID\),\s*\n\s*FOREIGN KEY/i);
    // Confirm there is no bare leading comma on its own line before FOREIGN KEY.
    expect(sql).not.toMatch(/^\s*,\s*\n\s*FOREIGN KEY/im);
  });

  it('skips draft tables without the FK column', () => {
    patchDraftCascadeConstraints(tmp);
    const sql = fs.readFileSync(path.join(tmp, 'AdminService.NoFk_drafts.hdbtable'), 'utf8');
    expect(sql).not.toMatch(/ON DELETE CASCADE/i);
  });

  it('is idempotent — second run adds no duplicate FK', () => {
    patchDraftCascadeConstraints(tmp);
    const first = fs.readFileSync(path.join(tmp, 'AdminService.Missions_drafts.hdbtable'), 'utf8');
    patchDraftCascadeConstraints(tmp);
    expect(fs.readFileSync(path.join(tmp, 'AdminService.Missions_drafts.hdbtable'), 'utf8')).toBe(first);
  });

  it('throws when no draft tables are found', () => {
    expect(() => patchDraftCascadeConstraints(emptyTmp)).toThrow(/no .*_drafts\.hdbtable/i);
  });
});
