import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Regression guard for the Path Items "Task" column value-help (F4) icon (#426).
//
// This value help must differ by row type: TUTORIAL -> Tutorials picker,
// GROUP -> Groups picker, CHECKPOINT -> free-text checkpoint title.
//
// Long history of failed approaches (ALL verified broken 2026-07-27; do NOT
// reintroduce any of them):
//   * #1331 eager-load + #1345 targetType:'any' on a core:require handler: the
//     handler module loads lazily and loses the race against FE's synchronous
//     column-template clone on the DEPLOYED shell (admin child components ship
//     without a Component-preload.js). Unresolved handler at clone time ->
//     showValueHelp expression degraded to a bare taskType path -> String
//     coerced to Boolean -> FormatException "TUTORIAL is not a valid boolean
//     value" -> no icon. Passed local/standalone checks, failed on DEV.
//   * Native macros:Field with `visible` / VBox wrappers / multiple stacked
//     Fields: FE allows exactly ONE building block per custom column cell;
//     anything else throws "c?.isA is not a function" and blanks the object page
//     (macros:Field has no `visible` property).
//
// Working fix (verified locally end-to-end against real HANA — the "Select
// Tutorial" picker opens): a SINGLE sap.m.Input whose handlers/formatters resolve
// to methods on the BranchAnalyticsHandler controllerExtension via the
// `.extension.<fqn>.` path. FE instantiates controllerExtensions during OP
// component init — BEFORE cloning the LineItem column templates — so the
// resolution is deterministic and race-free (no core:require). showValueHelp uses
// a formatter with targetType:'any' so the String taskType reaches the formatter
// without Boolean coercion.
const MISSIONS = join(process.cwd(), 'app', 'admin', 'missions', 'webapp');
const DEAD_HANDLER = 'sap/tutorials/admin/missions/ext/TaskColumnHandler';
const EXT_FQN = '.extension.sap.tutorials.admin.missions.ext.BranchAnalyticsHandler.';

describe('missions Path Items TaskColumn value-help', () => {
  const frag = readFileSync(join(MISSIONS, 'ext', 'TaskColumn.fragment.xml'), 'utf8');
  const handler = readFileSync(join(MISSIONS, 'ext', 'BranchAnalyticsHandler.controller.js'), 'utf8');

  it('renders a single sap.m.Input cell (FE allows one building block per custom column)', () => {
    const inputCount = (frag.match(/<Input\b/g) || []).length;
    expect(inputCount).toBe(1);
    // No native macros:Field with an unsupported `visible` attr, no wrappers.
    expect(frag).not.toMatch(/<macros:Field[^>]*\svisible\s*=/);
  });

  it('resolves handlers/formatters via the controllerExtension .extension path (no core:require race)', () => {
    expect(frag).not.toMatch(/core:require\s*=/);
    expect(frag).toContain(EXT_FQN + 'formatTaskShowValueHelp');
    expect(frag).toContain(EXT_FQN + 'onTaskValueHelp');
    expect(frag).toContain(EXT_FQN + 'formatTaskDisplay');
  });

  it('showValueHelp uses a formatter with targetType:any (no Boolean coercion of the String taskType)', () => {
    // Must be a formatter binding on taskType with targetType:'any' — NOT a bare
    // `{= ${taskType} ... }` expression (which coerces and throws FormatException).
    expect(frag).toMatch(/showValueHelp\s*=\s*"\{[^"]*path:\s*'taskType'[^"]*targetType:\s*'any'[^"]*formatTaskShowValueHelp[^"]*\}"/);
    expect(frag).not.toMatch(/showValueHelp\s*=\s*"\{=\s*\$\{taskType\}/);
  });

  it('the controllerExtension exposes the per-type value-help methods', () => {
    for (const m of ['formatTaskDisplay', 'formatTaskPlaceholder', 'formatTaskShowValueHelp',
                     'onTaskValueHelp', 'onTaskCheckpointChange']) {
      expect(handler).toMatch(new RegExp(m + '\\s*:\\s*function'));
    }
    // CHECKPOINT is free-text (no picker); TUTORIAL/GROUP show value help.
    expect(handler).toMatch(/sTaskType === "TUTORIAL" \|\| sTaskType === "GROUP"/);
  });

  it('the dead lazily-loaded TaskColumnHandler module is gone and not eager-loaded', () => {
    expect(existsSync(join(MISSIONS, 'ext', 'TaskColumnHandler.js'))).toBe(false);
    const comp = readFileSync(join(MISSIONS, 'Component.js'), 'utf8');
    expect(comp).not.toContain(DEAD_HANDLER);
    expect(frag).not.toMatch(new RegExp(DEAD_HANDLER.replace(/\//g, '\\/')));
  });
});
