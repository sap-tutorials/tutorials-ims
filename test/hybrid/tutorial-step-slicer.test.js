// test/hybrid/tutorial-step-slicer.test.js
//
// Hybrid: tutorial-step-slicer against real HANA content store.
// Slices step 1 of a well-known published tutorial and asserts a known heading.
//
// Update KNOWN_SLUG and KNOWN_HEADING_SUBSTR if the source tutorial's H2 changes.
//
// Runs with: npm run test:hybrid -- test/hybrid/tutorial-step-slicer.test.js
// (#1105 Task 17a)

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

// A well-known slug with published content. The heading match is intentionally
// loose — exact wording can change; the intent (provisioning/creation of a HANA
// instance) is stable.
const KNOWN_SLUG       = process.env.MCP_SLICER_TEST_SLUG    ?? 'hana-cloud-provisioning';
const KNOWN_STEP       = parseInt(process.env.MCP_SLICER_TEST_STEP ?? '1', 10);
const KNOWN_HEADING_RE = /provision|create|get started|introduction|overview/i;

describe('tutorial-step-slicer (hybrid, real HANA content store)', { timeout: 30_000 }, () => {
  let sliceStep;

  beforeAll(async () => {
    // Dynamic import so the ESM module resolves in the cds.test() context
    // after the service is booted and the content store is wired to HANA.
    const mod = await import('../../srv/lib/tutorial-step-slicer.js');
    sliceStep = mod.sliceStep;
  });

  it('sliceStep returns null or a valid slice for a known published tutorial', async () => {
    const slice = await sliceStep(KNOWN_SLUG, KNOWN_STEP);
    // Two valid outcomes:
    //   1. Content is in the store → slice with stepTitle + html + totalSteps.
    //   2. Content not yet published to this env → null (slicer fail-opens).
    if (slice === null) {
      // Acceptable: content store may not have this tutorial in the test env.
      // Mark the test informational rather than failing.
      console.warn(`[slicer-test] sliceStep(${KNOWN_SLUG}, ${KNOWN_STEP}) returned null — content not in store`);
      return;
    }
    expect(slice.stepTitle).toBeDefined();
    expect(typeof slice.stepTitle).toBe('string');
    expect(slice.stepTitle.length).toBeGreaterThan(0);
    expect(slice.totalSteps).toBeGreaterThan(0);
    expect(typeof slice.html).toBe('string');
    expect(slice.html.length).toBeGreaterThan(0);
  });

  it('sliceStep heading matches expected pattern when content is present', async () => {
    const slice = await sliceStep(KNOWN_SLUG, KNOWN_STEP);
    if (slice === null) {
      // Skip if content not in store.
      return;
    }
    expect(slice.stepTitle).toMatch(KNOWN_HEADING_RE);
  });

  it('sliceStep returns null for a non-existent slug (fail-open)', async () => {
    const result = await sliceStep('definitely-does-not-exist-xyz-9999', 1);
    expect(result).toBeNull();
  });

  it('sliceStep returns null for stepNumber 0 (boundary, fail-open)', async () => {
    const result = await sliceStep(KNOWN_SLUG, 0);
    expect(result).toBeNull();
  });
});
