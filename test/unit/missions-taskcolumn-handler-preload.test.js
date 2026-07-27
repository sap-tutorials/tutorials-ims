import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Regression guard for the Path Items "Task" column value-help (F4) icon.
//
// Root cause (verified 2026-07-27 via Playwright on DEV + a faithful local
// hybrid repro): admin child components ship WITHOUT a Component-preload.js.
// On the deployed shell (which HAS a root preload, optimized async mode) the
// runtime requests components/missions/Component-preload.js, gets a
// non-executable HTML fallback, and the `core:require` handler resolves LATER
// than Fiori Elements' synchronous column-template clone. With `handler`
// unresolved at clone time the showValueHelp expression binding degraded to a
// bare path binding on the String `taskType`, which UI5 coerced to Boolean →
// FormatException → showValueHelp:false → no icon. This only reproduced under
// deployed load-timing, so two earlier fixes (#1331 eager-load, #1345
// targetType:'any') passed local checks yet failed on DEV.
//
// Fix: the Task column now uses native sap.fe.macros:Field building blocks
// (same pattern as the working sibling TypeColumn) gated by the server-computed
// show{Tutorial,Group,Checkpoint} Booleans. FE renders each field's value help
// natively from the existing @Common.ValueList annotations. There is no
// lazily-loaded module to race and no expression binding over a Boolean
// property to coerce — the failure mode is removed by construction.
//
// This guard locks in the native-macro shape and forbids the fragile patterns
// (core:require handler + showValueHelp expression) from creeping back.
const MISSIONS = join(process.cwd(), 'app', 'admin', 'missions', 'webapp');
const HANDLER_MODULE = 'sap/tutorials/admin/missions/ext/TaskColumnHandler';

describe('missions Path Items TaskColumn value-help', () => {
  const frag = readFileSync(join(MISSIONS, 'ext', 'TaskColumn.fragment.xml'), 'utf8');

  it('uses native sap.fe.macros:Field for each task type (tutorial/group/checkpoint)', () => {
    expect(frag).toContain('sap.fe.macros');
    expect(frag).toMatch(/<macros:Field[^>]*metaPath\s*=\s*"tutorial_ID"/);
    expect(frag).toMatch(/<macros:Field[^>]*metaPath\s*=\s*"group_ID"/);
    expect(frag).toMatch(/<macros:Field[^>]*metaPath\s*=\s*"checkpointTitle"/);
  });

  it('gates each field on the server-computed show* Boolean (no expression coercion)', () => {
    expect(frag).toMatch(/visible\s*=\s*"\{showTutorial\}"/);
    expect(frag).toMatch(/visible\s*=\s*"\{showGroup\}"/);
    expect(frag).toMatch(/visible\s*=\s*"\{showCheckpoint\}"/);
  });

  it('does NOT reintroduce the core:require handler that lost the deployed load race', () => {
    // Match the actual attribute usage, not the substring — the comment above
    // the fragment legitimately mentions `core:require` when explaining history.
    expect(frag).not.toMatch(/core:require\s*=/);
    expect(frag).not.toMatch(new RegExp(HANDLER_MODULE.replace(/\//g, '\\/')));
    // The dead handler module must be gone.
    expect(existsSync(join(MISSIONS, 'ext', 'TaskColumnHandler.js'))).toBe(false);
  });

  it('does NOT reintroduce a showValueHelp expression binding over the String taskType', () => {
    expect(frag).not.toMatch(/showValueHelp\s*=/);
    expect(frag).not.toMatch(/\$\{[^}]*taskType/);
  });

  it('Component.js no longer eager-loads the removed handler', () => {
    const src = readFileSync(join(MISSIONS, 'Component.js'), 'utf8');
    expect(src).not.toContain(HANDLER_MODULE);
  });
});
