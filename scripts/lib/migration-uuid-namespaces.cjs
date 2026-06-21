'use strict';

/**
 * Stable namespace UUIDs for the IMS → CAP migration.
 *
 * Issue #337. Each entity type gets a fixed namespace UUID; the migrator
 * derives every entity's CAP-side UUID via `uuidv5(String(legacyId), NS[type])`.
 * This makes the migration idempotent — re-running it produces the same UUIDs
 * for the same source rows, so CAP-era tables that hold FK references
 * (TutorialMeta, TutorialEmbedding, etc.) stay linked across re-runs.
 *
 * **THESE VALUES ARE PERMANENT.** Once a migrator run has used them, every
 * downstream row's identity depends on them. Changing any of these would
 * silently orphan every CAP-era FK reference in production.
 *
 * Generated via `crypto.randomUUID()` 2026-06-15 specifically for this
 * migration. They are otherwise meaningless — pure namespace anchors.
 *
 * Adding a new entity to the migrator: generate ONE new UUID, append it
 * here, never edit existing entries.
 */

const NAMESPACES = Object.freeze({
  tutorial:             'f68c8ae9-0afb-4444-8106-9996ffd1b567',
  mission:              'b8097f18-f17c-48d9-92ad-cac285c86462',
  group:                '6641bec0-4b74-41fc-be62-56d96cbe6fcc',
  step:                 'e8fa1c8e-dad3-40b3-862b-e19344d4958e',
  user:                 '0ccf60a8-0faa-4192-ae51-920799ff2501',
  tag:                  'a50b0748-fd6c-41d7-bb7b-606d8acd3463',
  event:                '2a92f903-397a-4c3d-aa31-ced9e5d375e7',
  prize:                'be2c6b76-9fd0-4da2-a09e-8704a3cb2162',
  accomplishment:       '329777c1-600a-4b18-bffa-dfbf5e9a09d5',
  completionpath:       '9b9081ac-f0f7-4656-aee7-6133af8799f5',
  completionpathitem:   'a12db605-3b38-4826-a4a4-fdce53777db2',
  taskrecord:           '3ea82d90-721c-44b3-b83c-90acc77f38bf',
  accomplishmentrecord: '0c8740bb-3ff6-478d-a05d-c368e6f2e175',
  prizerecord:          '206bcf19-2115-487f-94cb-7e41e73b7886',
  tutorialtag:          '2247f0d9-48f1-400d-ac73-8ce074633fe3',
  tutorialcontributor:  'eb6d99e6-a274-41b0-84de-e19b376f3668',  // added 2026-06-21 for #385 PR-2
  tutorialrepository:   '7bea6f53-ae05-4daa-a205-75482fa7eec3',  // added 2026-06-21 for #385 PR-2
});

module.exports = { NAMESPACES };
