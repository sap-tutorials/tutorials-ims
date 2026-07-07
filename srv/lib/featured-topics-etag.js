import { createHash } from 'node:crypto';

export function computeSnapshotEtag({ computedAt, slots }) {
  const canonical = [
    new Date(computedAt).toISOString(),
    ...[...slots]
      .sort((a, b) => a.slotOrder - b.slotOrder)
      .map(s => `${s.slotOrder}:${s.conceptSlug}:${(s.missionSlugs || []).join(',')}`),
  ].join('|');
  const digest = createHash('sha1').update(canonical).digest('hex');
  return `W/"${digest}"`;
}
