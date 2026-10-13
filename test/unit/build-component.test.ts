import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Unit test for the per-component build-or-copy seam extracted from
// app/admin-shell/scripts/copy-components.js. The real `ui5 build` is injected
// via `runBuild` so these tests never spawn a UI5 toolchain — they exercise the
// DECISION logic: preload vs raw-copy, the silent-but-logged fault-isolation
// fallback when a build throws, and the post-build dbg/map strip.

const { buildComponent } = require('../../app/admin-shell/scripts/build-component.cjs');

let work: string;
let src: string;
let dest: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'buildcomp-'));
  src = join(work, 'src', 'webapp');
  dest = join(work, 'dist', 'puzzles');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'Component.js'), 'sap.ui.define([],function(){});');
  writeFileSync(join(src, 'manifest.json'), '{"sap.app":{"id":"x"}}');
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('buildComponent', () => {
  it('runs ui5 build and reports preload mode when the component is in the allowlist', () => {
    const runBuild = vi.fn(() => {
      // Simulate ui5 build emitting a preload + its debug/map siblings.
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, 'Component-preload.js'), 'jQuery.sap.registerPreloadedModules({});');
      writeFileSync(join(dest, 'Component.js'), '/*min*/');
    });
    const res = buildComponent({ folder: 'puzzles', src, dest, isPreload: true, ui5Cli: '/fake/ui5.cjs', runBuild });

    expect(runBuild).toHaveBeenCalledOnce();
    expect(res).toEqual({ folder: 'puzzles', mode: 'preload', fellBack: false });
    expect(existsSync(join(dest, 'Component-preload.js'))).toBe(true);
  });

  it('falls back to raw copy (silent but logged) when ui5 build throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runBuild = vi.fn(() => { throw new Error('minify failed: Unexpected token'); });

    const res = buildComponent({ folder: 'puzzles', src, dest, isPreload: true, ui5Cli: '/fake/ui5.cjs', runBuild });

    // Fault isolation: the component is still shipped, via raw copy, and the
    // return value flags that it degraded so the caller can tally it.
    expect(res).toEqual({ folder: 'puzzles', mode: 'copy', fellBack: true });
    expect(existsSync(join(dest, 'Component.js'))).toBe(true);
    expect(existsSync(join(dest, 'Component-preload.js'))).toBe(false);
    // Logged, not thrown.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('puzzles'));
    warn.mockRestore();
  });

  it('raw-copies without calling ui5 build when the component is not in the allowlist', () => {
    const runBuild = vi.fn();
    const res = buildComponent({ folder: 'puzzles', src, dest, isPreload: false, ui5Cli: '/fake/ui5.cjs', runBuild });

    expect(runBuild).not.toHaveBeenCalled();
    expect(res).toEqual({ folder: 'puzzles', mode: 'copy', fellBack: false });
    expect(existsSync(join(dest, 'Component.js'))).toBe(true);
  });

  it('strips -dbg and .map files from the dest after a successful preload build', () => {
    const runBuild = vi.fn(() => {
      mkdirSync(join(dest, 'lib'), { recursive: true });
      writeFileSync(join(dest, 'Component-preload.js'), '/*preload*/');
      writeFileSync(join(dest, 'Component.js'), '/*min*/');
      writeFileSync(join(dest, 'Component.js.map'), '{}');
      writeFileSync(join(dest, 'Component-dbg.js'), '/*dbg*/');
      writeFileSync(join(dest, 'lib', 'solver-core.js'), '/*min*/');
      writeFileSync(join(dest, 'lib', 'solver-core-dbg.js'), '/*dbg*/');
      writeFileSync(join(dest, 'lib', 'solver-core.js.map'), '{}');
      writeFileSync(join(dest, 'lib', 'fill-worker.js'), '/*worker, keep*/');
    });

    buildComponent({ folder: 'puzzles', src, dest, isPreload: true, ui5Cli: '/fake/ui5.cjs', runBuild });

    // Debug + sourcemap stripped.
    expect(existsSync(join(dest, 'Component.js.map'))).toBe(false);
    expect(existsSync(join(dest, 'Component-dbg.js'))).toBe(false);
    expect(existsSync(join(dest, 'lib', 'solver-core-dbg.js'))).toBe(false);
    expect(existsSync(join(dest, 'lib', 'solver-core.js.map'))).toBe(false);
    // Preload, minified sources, and the raw worker file survive.
    expect(existsSync(join(dest, 'Component-preload.js'))).toBe(true);
    expect(existsSync(join(dest, 'Component.js'))).toBe(true);
    expect(readFileSync(join(dest, 'lib', 'fill-worker.js'), 'utf8')).toContain('keep');
  });
});
