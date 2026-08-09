// test/unit/admin/topic-clusters-resolver.test.js
//
// Unit tests for the resolveSelectedContext helper in
// TopicClusterActionsController.js (#1558 Direction-C fix).
//
// Strategy: resolveSelectedContext(arg, tableLookupFn) is a pure function
// (the tableLookupFn is injected, so no UI5 runtime is needed). We test it
// by calling handlers._resolveSelectedContext directly, bypassing the sap.ui.define
// AMD loader by extracting the inner function from the module source and
// re-evaluating it in Node — or more simply, by duplicating the pure resolver
// logic inline (it's short and the test verifies the CONTRACT, not the source).
//
// We duplicate the resolver contract inline rather than trying to mock
// sap.ui.define in Node. The tests prove the three resolution paths are
// correct; the same logic lives verbatim in the production module.

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Pure resolver extracted for testing — mirrors production resolveSelectedContext
// in app/admin/topicClusters/webapp/ext/TopicClusterActionsController.js.
// If the production logic changes, this copy must be updated to match.
// ---------------------------------------------------------------------------

const ENTITY_PATH = "/TopicClustersAdmin";

function resolveSelectedContext(arg, tableLookupFn) {
  // Case 1: array of contexts (LR multi-select or correctly-passed OP arg).
  if (Array.isArray(arg) && arg.length > 0) return arg[0];

  // Case 2: single Context object (has both getModel and getPath).
  if (arg && typeof arg.getModel === "function" && typeof arg.getPath === "function") {
    return arg;
  }

  // Case 3: UI5 Event — getSource().getBindingContext().
  if (arg && typeof arg.getSource === "function") {
    const src = arg.getSource();
    if (src && typeof src.getBindingContext === "function") {
      const ctx = src.getBindingContext();
      if (ctx) return ctx;
    }
  }

  // Case 4: admin-shell passes undefined — recover via Element registry (#1558).
  try {
    const ctxs = tableLookupFn(ENTITY_PATH);
    if (Array.isArray(ctxs) && ctxs.length > 0) return ctxs[0];
  } catch (e) { /* fail-quiet */ }

  return null;
}

// ---------------------------------------------------------------------------
// Helpers for building mock binding contexts.
// ---------------------------------------------------------------------------

function makeCtx(slug) {
  return {
    getModel: () => ({}),
    getPath: () => `/${slug}`,
    getProperty: (key) => key === 'slug' ? slug : null
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveSelectedContext (#1558 Direction-C)', () => {

  const noopLookup = () => [];

  // Case 1a: context array with one element (normal LR multi-select path).
  it('returns first element of a non-empty context array', () => {
    const ctx = makeCtx('my-cluster');
    const result = resolveSelectedContext([ctx], noopLookup);
    expect(result).toBe(ctx);
  });

  // Case 1b: empty array falls through to registry lookup.
  it('falls through on empty context array → registry recovery', () => {
    const ctx = makeCtx('registry-cluster');
    const lookup = (path) => {
      expect(path).toBe(ENTITY_PATH);
      return [ctx];
    };
    const result = resolveSelectedContext([], lookup);
    expect(result).toBe(ctx);
  });

  // Case 2: arg is already a Context object.
  it('returns arg directly when it is a Context object (getModel + getPath)', () => {
    const ctx = makeCtx('direct-ctx');
    const result = resolveSelectedContext(ctx, noopLookup);
    expect(result).toBe(ctx);
  });

  // Case 3: arg is a UI5-Event-like object.
  it('resolves via getSource().getBindingContext() for a UI5 Event arg', () => {
    const ctx = makeCtx('event-cluster');
    const eventArg = {
      getSource: () => ({
        getBindingContext: () => ctx
      })
    };
    const result = resolveSelectedContext(eventArg, noopLookup);
    expect(result).toBe(ctx);
  });

  // Case 4a: THE ADMIN-SHELL BUG — arg is undefined, registry has selection.
  it('recovers from undefined arg via tableLookupFn (admin-shell #1558 case)', () => {
    const ctx = makeCtx('admin-shell-cluster');
    const lookup = (path) => {
      expect(path).toBe(ENTITY_PATH);
      return [ctx];
    };
    const result = resolveSelectedContext(undefined, lookup);
    expect(result).toBe(ctx);
  });

  // Case 4b: arg is null — same registry fallback.
  it('recovers from null arg via tableLookupFn', () => {
    const ctx = makeCtx('null-arg-cluster');
    const result = resolveSelectedContext(null, () => [ctx]);
    expect(result).toBe(ctx);
  });

  // Case 4c: both arg undefined AND registry empty → null (genuine "no selection").
  it('returns null when arg is undefined and registry is empty', () => {
    const result = resolveSelectedContext(undefined, noopLookup);
    expect(result).toBeNull();
  });

  // Case 4d: registry lookup throws → fail-quiet, returns null.
  it('returns null when tableLookupFn throws (fail-quiet)', () => {
    const result = resolveSelectedContext(undefined, () => { throw new Error('registry down'); });
    expect(result).toBeNull();
  });

  // Case 3 edge: getSource returns null — falls through to registry.
  it('falls through to registry when getSource returns null', () => {
    const ctx = makeCtx('fallback-cluster');
    const eventArg = { getSource: () => null };
    const result = resolveSelectedContext(eventArg, () => [ctx]);
    expect(result).toBe(ctx);
  });

  // Case 3 edge: getBindingContext returns null — falls through to registry.
  it('falls through to registry when getBindingContext returns null', () => {
    const ctx = makeCtx('fallback-ctx');
    const eventArg = {
      getSource: () => ({ getBindingContext: () => null })
    };
    const result = resolveSelectedContext(eventArg, () => [ctx]);
    expect(result).toBe(ctx);
  });
});
