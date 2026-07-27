import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression guard for the Path Items "Task" column value-help (F4) icon.
//
// Root cause (verified live in the UI5 1.136 runtime, A/B tested):
// `showValueHelp` is a BOOLEAN control property. In a single-reference
// expression binding, UI5 applies the target property's type as the
// referenced part's targetType — so `{= ${taskType} !== 'CHECKPOINT' }`
// coerces the OData String `taskType` ("TUTORIAL") into a boolean before the
// expression runs, throwing FormatException ("TUTORIAL is not a valid boolean
// value"). The binding falls back to `false` and the icon never renders.
//
// Fix: opt the string part out of coercion with `targetType: 'any'` so the
// expression gets the raw string. This test locks that in.
//
// (A prior, separate change also eager-loads TaskColumnHandler in Component.js
// so the core:require formatter alias resolves before FE clones the column
// template — asserted below too, since without it the value/placeholder
// formatters can fail to resolve on a cold cache.)
const MISSIONS = join(process.cwd(), 'app', 'admin', 'missions', 'webapp');
const HANDLER_MODULE = 'sap/tutorials/admin/missions/ext/TaskColumnHandler';

describe('missions Path Items TaskColumn value-help', () => {
  it('showValueHelp binding opts taskType out of boolean coercion via targetType:any', () => {
    const frag = readFileSync(join(MISSIONS, 'ext', 'TaskColumn.fragment.xml'), 'utf8');
    // The showValueHelp expression must reference taskType with targetType:'any'
    // so the boolean control property does not coerce the String value.
    expect(frag).toMatch(/showValueHelp\s*=\s*"\{=\s*\$\{[^}]*path:\s*'taskType'[^}]*targetType:\s*'any'[^}]*\}\s*!==\s*'CHECKPOINT'\s*\}"/);
    // And it must NOT use the bare ${taskType} form that triggers the coercion throw.
    expect(frag).not.toMatch(/showValueHelp\s*=\s*"\{=\s*\$\{taskType\}/);
  });

  it('eager-loads TaskColumnHandler in Component.js so core:require formatters resolve', () => {
    const src = readFileSync(join(MISSIONS, 'Component.js'), 'utf8');
    expect(src).toContain(HANDLER_MODULE);
  });

  it('TaskColumn.fragment.xml references the handler module via core:require', () => {
    const frag = readFileSync(join(MISSIONS, 'ext', 'TaskColumn.fragment.xml'), 'utf8');
    expect(frag).toContain(HANDLER_MODULE);
  });
});
