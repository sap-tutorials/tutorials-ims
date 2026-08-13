import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

/**
 * CI guard for the `restrict_all_services: false` auth setting.
 *
 * Context: `.cdsrc.json` sets `cds.requires.auth.restrict_all_services = false`
 * on the xsuaa (hybrid/production) profiles. This is required so the
 * @cap-js-community/websocket plugin will accept the ANONYMOUS event-display
 * kiosk WebSocket — its `enforceAuth` (src/socket/base.js) blanket-rejects
 * anonymous sockets under xsuaa unless this flag is false, and it does NOT
 * honor a service's `@requires: 'any'` on its own.
 *
 * The cost of that flag is that it removes CAP's global safety net: normally,
 * with an auth strategy configured, any service WITHOUT an explicit
 * `@requires`/`@restrict` is auto-secured to `authenticated-user`. With the
 * flag off, such a service would silently become PUBLIC once it is served on
 * a protocol. This guard restores that safety net at CI time: every service
 * defined under srv/ MUST declare an explicit service-level `@requires` or
 * `@restrict` (any value, including 'any', counts as an explicit decision),
 * unless it is a known internal (non-exposed) service on the allowlist below.
 *
 * If this fails: add `@requires`/`@restrict` to the new service, or — only if
 * the service is genuinely internal and served on no protocol — add it to
 * INTERNAL_SERVICES with a justification.
 */

// Full CSN names of services that are intentionally NOT exposed on any
// protocol (no @path/@protocol/@odata/@rest) and therefore need no auth
// annotation. Keep this list tiny and justified.
const INTERNAL_SERVICES = new Set([
  // Internal scheduling event bus — target of srv.schedule(...).as() only.
  // No @path/@protocol; not reachable as an HTTP endpoint. See srv/cron-service.cds.
  'com.sap.developers.ims.CronService',
]);

function isRepoService(def) {
  const file = (def.$location && def.$location.file) || '';
  const norm = file.replace(/\\/g, '/');
  return /(^|\/)srv\//.test(norm) && !norm.includes('node_modules');
}

describe('auth guard: every srv/ service declares explicit @requires (restrict_all_services:false safety net)', () => {
  let csn;
  beforeAll(async () => {
    csn = await cds.load('*');
  });

  it('has no un-annotated service under srv/ outside the internal allowlist', () => {
    const offenders = [];
    for (const [name, def] of Object.entries(csn.definitions)) {
      if (def.kind !== 'service') continue;
      if (!isRepoService(def)) continue; // skip framework/plugin services
      if (INTERNAL_SERVICES.has(name)) continue;
      const hasRequires = def['@requires'] !== undefined && def['@requires'] !== null;
      const hasRestrict = def['@restrict'] !== undefined && def['@restrict'] !== null;
      if (!hasRequires && !hasRestrict) {
        offenders.push(name);
      }
    }
    expect(
      offenders,
      `These srv/ services have no explicit @requires/@restrict. With restrict_all_services:false ` +
      `they would be PUBLIC once served. Annotate them, or add to INTERNAL_SERVICES if truly internal:\n  ` +
      offenders.join('\n  '),
    ).toEqual([]);
  });
});
