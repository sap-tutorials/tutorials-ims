export type NavDir = 'next' | 'prev';

type StepNavFn = (dir: NavDir) => boolean;

// Hand-gesture navigation moves between STEPS within a tutorial — NOT between
// tutorials. The u1-object-page layout exposes `window.opStepNav(dir)`, which
// scrolls to the current ± 1 step and returns true when it actually moved.
// A missing hook (page without the object-page step machinery) or a boundary
// (first/last step, where opStepNav returns false) is a silent no-op.
export function dispatchNav(dir: NavDir): boolean {
  const fn = (globalThis as { opStepNav?: StepNavFn }).opStepNav;
  return typeof fn === 'function' ? fn(dir) === true : false;
}
