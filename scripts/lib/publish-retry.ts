export type FailureClass = 'transient' | 'permanent';

const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const TRANSIENT_CODES  = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'
]);

export function classifyError(err: any): FailureClass {
  if (err == null) return 'permanent';
  if (typeof err.status === 'number') {
    return TRANSIENT_STATUS.has(err.status) ? 'transient' : 'permanent';
  }
  if (typeof err.code === 'string' && TRANSIENT_CODES.has(err.code)) return 'transient';
  if (err.name === 'AbortError') return 'transient';
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) return 'transient';
  return 'permanent';
}

export function formatErrorChain(err: any): string {
  const lines: string[] = [];
  let cur: any = err;
  let depth = 0;
  while (cur && depth < 10) {
    const prefix = depth === 0 ? '' : 'caused by: ';
    const ctor = cur.constructor?.name || 'Error';
    const meta: string[] = [];
    if (cur.code) meta.push(`code=${cur.code}`);
    if (cur.errno) meta.push(`errno=${cur.errno}`);
    if (cur.syscall) meta.push(`syscall=${cur.syscall}`);
    if (cur.status) meta.push(`status=${cur.status}`);
    const tail = meta.length ? `  [${meta.join(' ')}]` : '';
    lines.push(`${prefix}${ctor}: ${cur.message ?? String(cur)}${tail}`);
    cur = cur.cause;
    depth++;
  }
  return lines.join('\n  ');
}

export interface RetryOptions {
  attempts: number;
  backoffMs: number[];
  onAttemptFail?: (attempt: number, err: any, willRetry: boolean) => void;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  let lastErr: any;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const cls = classifyError(err);
      const willRetry = cls === 'transient' && attempt < opts.attempts;
      opts.onAttemptFail?.(attempt, err, willRetry);
      if (!willRetry) break;
      const wait = opts.backoffMs[Math.min(attempt - 1, opts.backoffMs.length - 1)];
      await new Promise(r => setTimeout(r, wait));
    }
  }
  if (lastErr && typeof lastErr === 'object') (lastErr as any).attempts = opts.attempts;
  throw lastErr;
}
