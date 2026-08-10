export type EmbedMode = 'none' | 'minimal' | 'reader';

export interface EmbedResolution {
  mode: EmbedMode | null;
  reset: boolean;
  pip: boolean;
  step: number | null;
  hostOrigin: string | null;
}

const MODES: readonly EmbedMode[] = ['none', 'minimal', 'reader'];

export function resolveEmbedParams(search: string): EmbedResolution {
  const q = new URLSearchParams(search);
  const host = q.get('host') === '1';

  const raw = q.get('embed');
  let mode: EmbedMode | null = null;
  let reset = false;
  if (raw === 'full') {
    reset = true;
  } else if (raw && (MODES as readonly string[]).includes(raw)) {
    mode = raw as EmbedMode;
  } else if (host) {
    mode = 'minimal';
  }

  const pip = q.get('pip') === '1' || host;

  const stepRaw = q.get('step');
  const stepNum = stepRaw != null ? Number(stepRaw) : NaN;
  const step = Number.isInteger(stepNum) && stepNum > 0 ? stepNum : null;

  const hostOrigin = q.get('host-origin');

  return { mode, reset, pip, step, hostOrigin: hostOrigin || null };
}
