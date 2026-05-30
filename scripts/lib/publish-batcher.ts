export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error('chunk size must be > 0');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export async function runConcurrent<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  if (concurrency <= 0) throw new Error('concurrency must be > 0');
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;
  let firstError: any = null;

  async function worker() {
    while (true) {
      if (firstError) return;
      const i = nextIndex++;
      if (i >= tasks.length) return;
      try {
        results[i] = await tasks[i]();
      } catch (err) {
        firstError ??= err;
        return;
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  if (firstError) throw firstError;
  return results;
}
