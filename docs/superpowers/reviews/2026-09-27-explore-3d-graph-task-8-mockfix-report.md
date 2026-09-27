# Test Fix Report: ThreeDGraph Async-Component Mock

**Date:** 2026-09-27  
**Task:** Fix failing test `case E: 2D→3D→2D round-trip clears pathNodeIds` in `app/explore/src/__tests__/App.test.ts`  
**Commit SHA:** `8b5be5cb`

## Status

FIXED - All tests passing.

## Root Cause

When `view3d = true` is set in case E, Vue's `defineAsyncComponent()` resolver attempts to process `ThreeDGraph.vue`. The original mock:

```ts
vi.mock('../components/ThreeDGraph.vue', () => ({
  default: { name: 'ThreeDGraph', render: () => null },
}))
```

returned a plain object as the default export. Vue Test Utils' component detection then tried to access internal Vue markers (`__isTeleport`, `__isKeepAlive`, etc.) as named module exports, which weren't present, causing:

```
Error: [vitest] No "__isTeleport" export is defined on the "../components/ThreeDGraph.vue" mock.
```

The other four component mocks (ExploreGraph, ExploreHeader, NodeDetailPanel, MobileTypedList) didn't fail because they're statically imported and rendered directly, not through `defineAsyncComponent`.

## Solution

Changed the mock to import and spread the original module's exports, then override the default with a proper Vue component created with `defineComponent`:

```ts
vi.mock('../components/ThreeDGraph.vue', async (importOriginal) => {
  const actual = await importOriginal() as any
  return {
    ...actual,
    default: defineComponent({ name: 'ThreeDGraph', render: () => null }),
  }
})
```

This ensures all Vue internal markers are present on the module exports while providing a valid component stub for rendering.

## Test Results

**App.test.ts:** 5/5 passing (cases A–E all pass)  
**Full explore suite:** 62/62 passing across 11 test files

## Changes Made

- **File modified:** `app/explore/src/__tests__/App.test.ts`
  - Updated `defineComponent` import from 'vue'
  - Changed ThreeDGraph mock to use async factory with `importOriginal` + spread operator
  - Wrapped mock default export in `defineComponent()` with `defineComponent` imported within the test file imports

## Concerns

None. The fix is minimal, targeted, and does not touch product code or any other tests.
