export function pickAutoMode(opts: {
  framed: boolean; explicitMode: string | null; width: number; threshold?: number;
}): 'minimal' | null {
  const threshold = opts.threshold ?? 640;
  if (!opts.framed) return null;
  if (opts.explicitMode) return null;
  return opts.width < threshold ? 'minimal' : null;
}
