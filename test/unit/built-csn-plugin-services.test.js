/**
 * #1276 — regression guard for connect-time plugin services in the BUILT srv csn.
 *
 * Background: since #1182 the deployed CF app loads a precompiled, pinned
 * `srv/csn.json` (strip-precompiled-plugin-roots.js keeps model resolution at
 * `files.length === 1`). That means the runtime model is EXACTLY what the
 * `.cdsrc.json` srv build task emits — plugin models NOT in that task's `model`
 * list are absent at runtime, even though the plugin still registers handlers.
 *
 * The @cap-js/ai plugin (#959) auto-attaches a recommendations read-after-write
 * handler to every `@Common.ValueList` field on draft-enabled admin entities
 * (Events, Missions, Groups, …). That handler calls `cds.connect.to('AICore')`,
 * which throws at @sap/cds/lib/srv/cds-connect.js if `cds.requires.AICore.model`
 * is configured but the `AICore` service is missing from the loaded model. On
 * CF that manifested as a 500 on EVERY admin draft Create (#1276).
 *
 * Why no existing test caught it: every functional test (test/admin-drafts.test.js,
 * test/hybrid/cap-ai-plugin-boot.test.js) boots via `cds.test('serve', …)`, which
 * COMPILES THE MODEL FROM SOURCE ROOTS — the plugin's AICore service is always
 * present there. Only the built artifact drops it. No test loaded the built csn.
 *
 * This test closes that layer: it compiles the srv model using the exact model
 * list from `.cdsrc.json`'s nodejs build task and asserts the `AICore` service
 * — the connect-time model the @cap-js/ai handler resolves BY NAME (and throws
 * on if absent) — is present. If the build task's `model` list drops
 * `@cap-js/ai/srv/AICoreService`, this fails here instead of in production.
 *
 * Scope note: this guards AICore specifically because it is the one plugin the
 * runtime resolves via `cds.connect.to('<name>')` where `<name>` must be a
 * service definition in the loaded model. Other `cds.requires.*` entries with a
 * `.model` (queue/outbox, change-tracking, data-inspector, ORD) register at
 * runtime under names that are not literal csn service definitions, so a generic
 * "every requires.model resolves" sweep yields false positives — deliberately
 * avoided.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Read the nodejs srv build task's `model` list from .cdsrc.json — the single
 *  source of truth for what lands in the deployed srv/csn.json. */
function srvBuildModelList() {
  const cdsrc = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.cdsrc.json'), 'utf8'));
  const task = (cdsrc.build?.tasks ?? []).find(
    (t) => t.for === 'nodejs' && t.src === 'srv' && Array.isArray(t.options?.model),
  );
  if (!task) throw new Error('No nodejs srv build task with a model list found in .cdsrc.json');
  return task.options.model;
}

describe('#1276 — built srv csn contains the AICore connect-time service', () => {
  let builtModel;

  beforeAll(async () => {
    // Compile the model exactly as the build task defines it (same roots that
    // produce the deployed srv/csn.json), resolved relative to the repo root.
    const model = srvBuildModelList().map((m) =>
      m.startsWith('@') || m.includes('/node_modules/') ? m : path.join(REPO_ROOT, m),
    );
    builtModel = await cds.load(model, { root: REPO_ROOT });
  });

  it('AICore service is present (guards @cap-js/ai recommendations connect — #1276)', () => {
    const def = builtModel.definitions.AICore;
    expect(def, 'AICore missing from built srv csn — @cap-js/ai draft-Create handler will 500 on CF').toBeTruthy();
    expect(def.kind).toBe('service');
  });
});
