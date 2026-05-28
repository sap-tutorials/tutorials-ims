import { SEL_NAV_NEXT, SEL_NAV_PREV } from './constants';

export type NavDir = 'next' | 'prev';
const SEL: Record<NavDir, string> = { next: SEL_NAV_NEXT, prev: SEL_NAV_PREV };

export function hasNext(): boolean { return !!document.querySelector(SEL_NAV_NEXT); }
export function hasPrev(): boolean { return !!document.querySelector(SEL_NAV_PREV); }

export function dispatchNav(dir: NavDir): void {
  const a = document.querySelector(SEL[dir]) as HTMLAnchorElement | null;
  if (a) a.click();
}
