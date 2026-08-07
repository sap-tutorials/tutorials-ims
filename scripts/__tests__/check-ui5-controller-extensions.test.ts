// scripts/__tests__/check-ui5-controller-extensions.test.ts
//
// Unit tests for the UI5 controller-suffix-collision linter (#362, #539).
//
// The script catches two opposite filename-vs-loader-path bugs:
//
//   1. controllerExtensions[*].controllerName: file MUST be <Name>.controller.js
//      (loader appends .controller.js suffix). Original direction from #362.
//
//   2. press: "<dotted-name>.<methodName>" (FE V4): file MUST be <Name>.js
//      (loader treats the dotted prefix as a plain module). Added in #539
//      after PR #537 fixed Concepts and #538 flagged Categories as latent.
//
// Tests exercise the pure helper functions against synthetic inputs — same
// pattern as scripts/__tests__/check-build-collisions.test.ts. The
// integration check is the live `postbuild:apps` invocation in CI.

import { describe, it, expect } from 'vitest';
import {
  collectControllerNames,
  collectPressTargets,
  resolveModulePath,
  findHardcodedContainerViewIds,
} from '../check-ui5-controller-extensions';

describe('collectControllerNames', () => {
  it('extracts controllerName from controllerExtensions object', () => {
    const manifest = {
      'sap.ui5': {
        extends: {
          extensions: {
            'sap.ui.controllerExtensions': {
              'sap.fe.templates.ObjectPage.ObjectPageController': {
                controllerName: 'sap.tutorials.admin.missions.ext.BranchAnalyticsHandler',
              },
            },
          },
        },
      },
    };
    expect(collectControllerNames(manifest)).toEqual([
      'sap.tutorials.admin.missions.ext.BranchAnalyticsHandler',
    ]);
  });

  it('returns empty array when no controllerExtensions present', () => {
    expect(collectControllerNames({})).toEqual([]);
    expect(collectControllerNames({ 'sap.ui5': {} })).toEqual([]);
  });
});

describe('collectPressTargets (#539)', () => {
  it('extracts dotted module from press: "<module>.<method>" string', () => {
    const manifest = {
      'sap.ui.generic.app': {
        pages: [
          {
            settings: {
              controlConfiguration: {
                '@com.sap.vocabularies.UI.v1.LineItem': {
                  actions: {
                    classifyUncategorized: {
                      press: 'sap.tutorials.admin.categories.ext.CategoryActionsController.onClassifyUncategorized',
                    },
                  },
                },
              },
            },
          },
        ],
      },
    };
    expect(collectPressTargets(manifest)).toEqual([
      'sap.tutorials.admin.categories.ext.CategoryActionsController',
    ]);
  });

  it('extracts multiple press targets and dedupes by module (not method)', () => {
    // Three press: references on the same module — the LINT cares about
    // the module path being loadable, not each method. Dedupe.
    const manifest = {
      controlConfiguration: {
        actions: {
          a: { press: 'app.ns.ext.Foo.methodA' },
          b: { press: 'app.ns.ext.Foo.methodB' },
          c: { press: 'app.ns.ext.Bar.methodC' },
        },
      },
    };
    const out = collectPressTargets(manifest);
    expect(out.sort()).toEqual(['app.ns.ext.Bar', 'app.ns.ext.Foo']);
  });

  it('ignores press: that does NOT look like a dotted module path', () => {
    // FE V4 also accepts press: ".localHandler" (controller-extension-local
    // handler binding). Those aren't module references and shouldn't be
    // checked here.
    const manifest = {
      actions: {
        a: { press: '.onLocalHandler' },
        b: { press: 'app.ns.ext.RealModule.onAction' },
      },
    };
    expect(collectPressTargets(manifest)).toEqual(['app.ns.ext.RealModule']);
  });

  it('handles arrays of objects (FE V4 menu actions)', () => {
    const manifest = {
      pages: [
        { actions: [{ press: 'app.ns.ext.Foo.onA' }, { press: 'app.ns.ext.Foo.onB' }] },
      ],
    };
    expect(collectPressTargets(manifest)).toEqual(['app.ns.ext.Foo']);
  });

  it('skips press: with no dot separator (single identifier)', () => {
    // Defensive — a malformed press reference like just "onAction" has
    // no dotted path; nothing to verify.
    const manifest = {
      actions: { a: { press: 'onAction' } },
    };
    expect(collectPressTargets(manifest)).toEqual([]);
  });

  it('returns empty array when no press: refs present', () => {
    expect(collectPressTargets({})).toEqual([]);
    expect(collectPressTargets({ 'sap.app': { id: 'x' } })).toEqual([]);
  });
});

describe('resolveModulePath', () => {
  // The script uses Node path-join, which produces forward slashes on Unix
  // and backslashes on Windows. The lint's output cares about EXISTENCE,
  // not string equality, so we just check the suffix.
  it('strips the app namespace prefix and resolves to webapp-relative path', () => {
    const result = resolveModulePath(
      'sap.tutorials.admin.missions.ext.BranchAnalyticsHandler',
      'sap.tutorials.admin.missions',
      '/abs/app/admin/missions/webapp',
    );
    // Two-part check: ends with the expected relative path.
    expect(result.jsPath.replace(/\\/g, '/')).toBe('/abs/app/admin/missions/webapp/ext/BranchAnalyticsHandler.js');
    expect(result.controllerJsPath.replace(/\\/g, '/')).toBe('/abs/app/admin/missions/webapp/ext/BranchAnalyticsHandler.controller.js');
  });

  it('handles nested subdirs in the module path', () => {
    const result = resolveModulePath(
      'app.ns.ext.deep.Nested',
      'app.ns',
      '/r/webapp',
    );
    expect(result.jsPath.replace(/\\/g, '/')).toBe('/r/webapp/ext/deep/Nested.js');
  });
});

describe('findHardcodedContainerViewIds (#1105, #1530 / direction C)', () => {
  it('flags a hardcoded standalone FE container view id for the app', () => {
    // The exact anti-pattern that shipped in TagImportController before #1530.
    const src =
      'candidate = core.byId("container-sap.tutorials.admin.tags---sap.fe.templates.ListReport.view.ListReport");';
    expect(
      findHardcodedContainerViewIds(src, 'sap.tutorials.admin.tags'),
    ).toEqual([
      'container-sap.tutorials.admin.tags---sap.fe.templates.ListReport.view.ListReport',
    ]);
  });

  it('flags an ObjectPage-flavoured hardcoded id too', () => {
    const src =
      "byId('container-sap.tutorials.admin.pats---sap.fe.templates.ObjectPage.view.Details')";
    expect(
      findHardcodedContainerViewIds(src, 'sap.tutorials.admin.pats'),
    ).toEqual([
      'container-sap.tutorials.admin.pats---sap.fe.templates.ObjectPage.view.Details',
    ]);
  });

  it('does NOT flag a comment that merely mentions another app id', () => {
    // kgCommunities keeps the old id in a historical comment; scanning it with
    // ITS OWN namespace must stay clean (the mentioned id is a different app).
    const src =
      '// the old fallback id "container-sap.tutorials.admin.tags---sap.fe.templates..." is gone';
    expect(
      findHardcodedContainerViewIds(src, 'sap.tutorials.admin.kgCommunities'),
    ).toEqual([]);
  });

  it('flags a hardcoded id even inside a comment for the SAME app (belt-and-braces)', () => {
    // We intentionally scan comments too — a copy-paste into live code is one
    // keystroke away, and the ElementRegistry path never needs this literal.
    const src =
      '// container-sap.tutorials.admin.tags---sap.fe.templates.ListReport.view.ListReport';
    expect(
      findHardcodedContainerViewIds(src, 'sap.tutorials.admin.tags'),
    ).toHaveLength(1);
  });

  it('returns empty for the ElementRegistry-based resolution (the fix)', () => {
    const src = `
      const registry = sap.ui.require("sap/ui/core/ElementRegistry");
      const anchor = registry.get("sap.tutorials.admin.tags::TagsList--fe::table::Tags::LineItem-innerTable");
      registry.forEach(function (el, id) { if (/tags::TagsList$/.test(id)) candidate = el; });
    `;
    expect(
      findHardcodedContainerViewIds(src, 'sap.tutorials.admin.tags'),
    ).toEqual([]);
  });

  it('finds multiple hardcoded ids in one file', () => {
    const src = `
      a = core.byId("container-app.ns---sap.fe.templates.ListReport.view.ListReport");
      b = core.byId("container-app.ns---sap.fe.templates.ObjectPage.view.OP");
    `;
    expect(findHardcodedContainerViewIds(src, 'app.ns')).toHaveLength(2);
  });
});
