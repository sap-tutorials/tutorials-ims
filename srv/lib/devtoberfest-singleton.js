// Shared singleton-init logic for DevtoberfestConfig.
//
// Both srv/admin-service.js (before-READ handler) and
// srv/routes/devtoberfest-public.js (raw express route) need to
// ensure the singleton row exists before any read. This module is
// the single source of truth for the singleton UUID and the
// check-then-INSERT pattern.
//
// Race-tolerant: the unique-on-PK constraint at the DB layer ensures
// at most one row regardless of concurrent first-request bootstrap.
// A concurrent INSERT will surface as a unique-violation thrown from
// the second writer; callers should let that bubble so the request
// can be retried.
//
// Spec: docs/superpowers/specs/2026-06-22-devtoberfest-homepage-design.md §5.1

import cds from '@sap/cds';

export const DEVTOBERFEST_CONFIG_SINGLETON_ID = '00000000-0000-0000-0000-00d0fe57feed';

export async function ensureDevtoberfestConfigSingleton() {
  const { DevtoberfestConfig } = cds.entities('com.sap.developers.ims');
  const existing = await SELECT.one.from(DevtoberfestConfig)
    .where({ ID: DEVTOBERFEST_CONFIG_SINGLETON_ID });
  if (!existing) {
    await INSERT.into(DevtoberfestConfig).entries({
      ID: DEVTOBERFEST_CONFIG_SINGLETON_ID,
      termsVersion: 1,
    });
  }
}
