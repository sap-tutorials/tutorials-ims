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
