export interface RingState {
  count: number
}

export function reset(): RingState {
  return { count: 0 }
}

export function collect(s: RingState): RingState {
  return { count: s.count + 1 }
}

export function onHit(s: RingState): { next: RingState; scattered: number } {
  return {
    next: { count: 0 },
    scattered: s.count
  }
}
