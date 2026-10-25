import cds from '@sap/cds';

export default class DrawingService extends cds.ApplicationService {

  async init() {
    const { Events, PrizeRecords, Users, UserIdentities } = cds.entities('com.sap.developers.ims');

    // Synthetic GitHub privacy emails (jung-thomas@users.noreply.github.com) are
    // dirty data, never a real contact address — exclude them from the fallback,
    // same posture as resolve-db-user.js's NOREPLY_GITHUB_RE (#2552).
    const NOREPLY_GITHUB_RE = /@users\.noreply\.github\.com$/i;

    // Best contact email for a set of users, mirroring the two-source model the
    // identity-linkage layer maintains (#2552): Users.email is NULL on ~97.6% of
    // migrated rows and only backfills lazily on login, but UserIdentities.email
    // (the per-IdP asserted address) is written on every tiered link-write. So a
    // winner with a blank Users.email often still has a usable email on their
    // UserIdentities rows. Returns a map { user_ID -> email }, preferring verified
    // links, then most-recently-linked. Read-only; fail-safe (no row -> absent).
    async function identityEmailByUser(userIds) {
      if (!userIds.length) return {};
      const links = await SELECT.from(UserIdentities)
        .columns('user_ID', 'email', 'emailVerified', 'linkedAt')
        .where({ user_ID: { in: userIds } });

      const best = {};
      for (const l of links) {
        if (!l.email || NOREPLY_GITHUB_RE.test(l.email)) continue;
        const cur = best[l.user_ID];
        // Prefer a verified link; among equal verified-ness, the newest linkedAt.
        if (!cur
          || (!!l.emailVerified && !cur.emailVerified)
          || (!!l.emailVerified === !!cur.emailVerified && (l.linkedAt ?? '') > (cur.linkedAt ?? ''))) {
          best[l.user_ID] = l;
        }
      }
      return Object.fromEntries(Object.entries(best).map(([id, l]) => [id, l.email]));
    }

    // Resolve an event by legacyId; rejects with 404 if not found (mirrors display-service.js pattern).
    async function resolveEvent(eventLegacyId, req) {
      const event = await SELECT.one.from(Events).where({ legacyId: eventLegacyId });
      if (!event) { req.reject(404, `Event not found: ${eventLegacyId}`); return null; }
      return event;
    }

    // Returns distinct non-anonymized Users who have at least one CLAIMED PrizeRecord for the given event UUID.
    async function eligibleUserIds(eventID) {
      const claimed = await SELECT.from(PrizeRecords)
        .columns('user_ID')
        .where({ event_ID: eventID, status: 'CLAIMED' });

      const ids = [...new Set(claimed.map(r => r.user_ID))];
      if (!ids.length) return [];

      const users = await SELECT.from(Users)
        .columns('ID', 'displayName', 'email')
        .where({ ID: { in: ids } });

      // Exclude anonymized users
      const active = users.filter(u => u.displayName !== 'ANONYMIZED');

      // Fall back to a UserIdentities email for anyone whose Users.email is blank
      // (the #2552 two-source model — see identityEmailByUser). Only query for the
      // users that actually need it.
      const needFallback = active.filter(u => !u.email).map(u => u.ID);
      const fallback = await identityEmailByUser(needFallback);
      return active.map(u => ({ ...u, email: u.email || fallback[u.ID] || null }));
    }

    this.on('listEvents', async () => {
      // Find distinct event IDs that have at least one CLAIMED PrizeRecord
      const claimed = await SELECT.distinct.from(PrizeRecords)
        .columns('event_ID')
        .where({ status: 'CLAIMED' });

      if (!claimed.length) return [];

      const eventIds = claimed.map(r => r.event_ID);

      const events = await SELECT.from(Events)
        .columns('legacyId', 'name', 'startDate')
        .where({ ID: { in: eventIds } })
        .orderBy({ startDate: 'desc' });

      return events;
    });

    this.on('pool', async (req) => {
      const { eventId } = req.data;
      const event = await resolveEvent(eventId, req);
      if (!event) return;

      const eligible = await eligibleUserIds(event.ID);
      return { eventId, eligibleCount: eligible.length };
    });

    this.on('draw', async (req) => {
      const { eventId } = req.data;
      const event = await resolveEvent(eventId, req);
      if (!event) return;

      const eligible = await eligibleUserIds(event.ID);

      if (!eligible.length) {
        return { winner: null, eligibleCount: 0 };
      }

      const winner = eligible[Math.floor(Math.random() * eligible.length)];
      return {
        winner: { displayName: winner.displayName, email: winner.email ?? null },
        eligibleCount: eligible.length
      };
    });

    await super.init();
  }
}
