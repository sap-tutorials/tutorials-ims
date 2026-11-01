// Reconciliation for the live event display.
//
// The display seeds bucket counts once from getEventBuckets, then mutates them
// incrementally from socket completion events. Any missed socket event (reconnect
// gap, multi-instance session flap, dropped long-poll cycle) leaves the display
// permanently behind the true total — the historical "numbers don't update live
// / have to refresh the kiosk" bug. Periodic reconciliation against the
// authoritative getEventBuckets snapshot heals that drift without a page refresh.

export interface DisplayBucket {
  name: string;
  count: number;
  justUpdated: boolean;
}

export interface FetchedBucket {
  bucketName: string;
  count: number;
}

/**
 * Merge an authoritative getEventBuckets snapshot into the current display state.
 *
 * - Corrects counts that drifted BELOW the snapshot (missed socket events) by
 *   adopting the snapshot value.
 * - Adds buckets present only in the snapshot.
 * - Is MONOTONIC: never lowers a count the display already shows, because a live
 *   socket delta may have arrived after the snapshot was taken (the display is
 *   momentarily ahead). Rewinding would cause a visible backwards jump.
 */
export function reconcileBuckets(
  current: DisplayBucket[],
  fetched: FetchedBucket[],
): DisplayBucket[] {
  const byName = new Map(current.map(b => [b.name, { ...b }]));

  for (const f of fetched) {
    const existing = byName.get(f.bucketName);
    if (existing) {
      // Monotonic: adopt the snapshot only when it is ahead of what we show.
      if (f.count > existing.count) existing.count = f.count;
    } else {
      byName.set(f.bucketName, { name: f.bucketName, count: f.count, justUpdated: false });
    }
  }

  return [...byName.values()];
}
