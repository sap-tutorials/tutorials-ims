/**
 * Returns true only when an item counts as "complete" for segment satisfaction.
 *
 * Rules (#2866/#2864):
 *   - status must be exactly 'COMPLETED' (not COMPLETED_OUT_OF_WINDOW or anything else)
 *   - temporarilyUnavailable items are never complete regardless of status
 *
 * @param {object} item - shapeItem-shaped output item.
 * @returns {boolean}
 */
function isComplete(item) {
  if (item.temporarilyUnavailable) return false;
  return item.status === 'COMPLETED';
}

/**
 * Returns true when a lane (array of items) is "complete" for fork-join purposes.
 * A lane is complete when every item (tutorials + synthetic checkpoint prize) is complete.
 *
 * @param {Array<object>} items - Lane items.
 * @returns {boolean}
 */
function isLaneComplete(items) {
  return items.every(item => isComplete(item));
}

/**
 * Returns true when a lane's tutorials (i.e. non-prize items) are all complete,
 * which is the condition for unlocking that lane's own synthetic prize item.
 *
 * @param {Array<object>} items - Lane items.
 * @returns {boolean}
 */
function isLaneTutorialsComplete(items) {
  const tutorials = items.filter(item => !item.prizeId);
  return tutorials.length > 0 && tutorials.every(item => isComplete(item));
}

/**
 * Returns true when a segment is "satisfied" — i.e. all required work is done.
 * Composes with #2866 (COMPLETED_OUT_OF_WINDOW) and #2864 (temporarilyUnavailable).
 *
 * @param {object} segment - A LinearSegment, ClusterSegment, or ForkSegment.
 * @returns {boolean}
 */
function isSegmentSatisfied(segment) {
  if (segment.kind === 'linear') {
    return segment.items.every(item => isComplete(item));
  }
  if (segment.kind === 'parallel-any') {
    return segment.items.every(item => isComplete(item));
  }
  if (segment.kind === 'fork') {
    // All lanes must be complete for the fork to be satisfied (join gate).
    return segment.lanes.every(l => isLaneComplete(l.items));
  }
  return false;
}

/**
 * Annotates every output item in the segment array with an `unlocked` boolean.
 *
 * Rules:
 *   - First segment is always unlocked.
 *   - Segment N unlocks when segment N-1 is satisfied.
 *   - For a fork: all lanes' items unlock together (they share the segment's
 *     unlock state), EXCEPT for synthetic prize items which unlock independently
 *     per-lane when that lane's own tutorials are complete.
 *
 * Mutates items in-place and returns the segments array.
 *
 * @param {Array<object>} segments - Array of LinearSegment | ClusterSegment | ForkSegment.
 * @returns {Array<object>} The same segments array with `unlocked` set on each item.
 */
export function annotateUnlocked(segments) {
  let prevSatisfied = true; // Conceptual "segment -1" is always satisfied.

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    // A segment is unlocked when i===0 (first) OR the previous segment was satisfied.
    const segmentUnlocked = (i === 0) || prevSatisfied;

    if (segment.kind === 'linear' || segment.kind === 'parallel-any') {
      for (const item of segment.items) {
        item.unlocked = segmentUnlocked;
      }
    } else if (segment.kind === 'fork') {
      for (const l of segment.lanes) {
        const laneTutsDone = isLaneTutorialsComplete(l.items);
        for (const item of l.items) {
          if (item.prizeId) {
            // Synthetic lane prize: unlocks when THIS lane's tutorials are complete
            // and the segment itself is unlocked. Independent of other lanes.
            item.unlocked = segmentUnlocked && laneTutsDone;
          } else {
            item.unlocked = segmentUnlocked;
          }
        }
      }
    }

    prevSatisfied = isSegmentSatisfied(segment);
  }

  return segments;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Groups a CompletionPath's items by itemOrder and classifies each group's shape.
 * Pure JS function with no DB access.
 *
 * @param {Array<object>} pathItems - Raw CompletionPathItems rows. Fields used: itemOrder, taskType.
 *                                    Input need not be pre-sorted.
 * @returns {Array<{order: number, kind: string, members: Array<object>}>}
 *          Segments sorted ascending by order.
 *          kind: 'linear' (1 member), 'parallel-any' (2+ all TUTORIAL), 'fork' (2+ with any GROUP).
 */
export function classifyPathSegments(pathItems) {
  // Group by itemOrder
  const grouped = new Map();
  for (const item of pathItems) {
    const order = item.itemOrder;
    if (!grouped.has(order)) {
      grouped.set(order, []);
    }
    grouped.get(order).push(item);
  }

  // Sort orders ascending and classify each group
  const orders = Array.from(grouped.keys()).sort((a, b) => a - b);
  const segments = [];

  for (const order of orders) {
    const members = grouped.get(order);
    let kind;

    if (members.length === 1) {
      kind = 'linear';
    } else {
      // 2+ members: check if any are GROUP
      const hasGroup = members.some(m => m.taskType === 'GROUP');
      kind = hasGroup ? 'fork' : 'parallel-any';
    }

    segments.push({
      order,
      kind,
      members
    });
  }

  return segments;
}
