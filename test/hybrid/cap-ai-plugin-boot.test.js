/**
 * #959 PR 2 — hybrid smoke test for the @cap-js/ai plugin.
 *
 * Verifies srv boots with the plugin against a real `aicore` VCAP binding
 * (via `cds bind`), and `cds.connect.to('AICore')` returns a service handle
 * exposing the plugin's declared entities.
 *
 * Does NOT invoke RPT-1 predictions — those would burn AI Core quota per
 * test run. This is a boot-time regression gate: if the plugin's
 * `cds.requires.AICore` block or the aicore binding drifts, this test
 * fails and CI catches it before deploy.
 *
 * Run with: cf login + cds bind --exec -- npx vitest run --project hybrid test/hybrid/cap-ai-plugin-boot.test.js
 */
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

describe('#959 PR 2 — @cap-js/ai plugin hybrid boot', () => {
  it('cds.connect.to("AICore") succeeds against the real aicore binding', async () => {
    const aiCore = await cds.connect.to('AICore');
    expect(aiCore).toBeTruthy();
    // The plugin's AICoreService.cds declares these entities. We only assert
    // they exist on the connected service — reading rows would hit AI Core.
    expect(aiCore.entities).toBeTruthy();
    expect(aiCore.entities.resourceGroups).toBeTruthy();
    expect(aiCore.entities.deployments).toBeTruthy();
    expect(aiCore.entities.configurations).toBeTruthy();
  });

  it('is configured with resourceGroup="default"', () => {
    const aiCoreConfig = cds.env.requires.AICore;
    expect(aiCoreConfig).toBeTruthy();
    expect(aiCoreConfig.resourceGroup).toBe('default');
  });
});
