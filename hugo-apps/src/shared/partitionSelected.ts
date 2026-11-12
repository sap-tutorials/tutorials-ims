/**
 * Partitions an array into two groups: selected items first, unselected items after.
 * Preserves relative order within each group.
 *
 * @param list The array to partition
 * @param isSelected Function to determine if an item is selected
 * @returns A new array with selected items first, then unselected items
 */
export function partitionSelected<T>(
  list: T[],
  isSelected: (item: T) => boolean,
): T[] {
  const selected: T[] = []
  const unselected: T[] = []

  for (const item of list) {
    if (isSelected(item)) {
      selected.push(item)
    } else {
      unselected.push(item)
    }
  }

  return [...selected, ...unselected]
}
