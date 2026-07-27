import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression guard for the Path Items "Task" column value-help icon.
//
// TaskColumn.fragment.xml loads its logic via
//   core:require="{ handler: 'sap/tutorials/admin/missions/ext/TaskColumnHandler' }"
// Admin child components are raw-copied into the shell without a per-component
// `ui5 build` (app/admin-shell/scripts/copy-components.js), so there is NO
// Component-preload.js bundling that module. If it is not already in the module
// cache when Fiori Elements clones the completionPaths LineItem column template,
// the `handler` alias is unresolved and the
//   showValueHelp="{= ${taskType} !== 'CHECKPOINT' }"
// expression binding silently degrades to a plain path binding on `taskType`
// (coerced to a non-boolean) → the F4 value-help icon disappears.
//
// The fix is to declare TaskColumnHandler as an eager dependency of the
// missions Component so it is resolved+cached before the factory runs. This
// test locks that in.
const MISSIONS = join(process.cwd(), 'app', 'admin', 'missions', 'webapp');
const HANDLER_MODULE = 'sap/tutorials/admin/missions/ext/TaskColumnHandler';

describe('missions Component eagerly preloads TaskColumnHandler', () => {
  it('lists TaskColumnHandler in the Component.js sap.ui.define dependency array', () => {
    const src = readFileSync(join(MISSIONS, 'Component.js'), 'utf8');
    expect(src).toContain(HANDLER_MODULE);
  });

  it('TaskColumn.fragment.xml references the same handler module via core:require', () => {
    const frag = readFileSync(join(MISSIONS, 'ext', 'TaskColumn.fragment.xml'), 'utf8');
    expect(frag).toContain(HANDLER_MODULE);
  });
});
