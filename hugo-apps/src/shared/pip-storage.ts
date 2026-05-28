// hugo-apps/src/shared/pip-storage.ts
import type { PipMode } from './pip-types';

export const PIP_MODE_KEY = 'sap-tutorials-pip-mode';

export function loadPipMode(): PipMode {
  try {
    const v = localStorage.getItem(PIP_MODE_KEY);
    return v === 'controller' ? 'controller' : 'full';
  } catch {
    return 'full';
  }
}

export function savePipMode(mode: PipMode): void {
  try {
    localStorage.setItem(PIP_MODE_KEY, mode);
  } catch {
    // ignore quota / private-mode failures
  }
}
