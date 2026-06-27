import { describe, it, expect, vi } from 'vitest';
import { createAuditEmitter } from '../../srv/lib/audit-event.js';

describe('createAuditEmitter', () => {
  it('returns a noop when audit-log binding is null', async () => {
    const emit = createAuditEmitter(null, console);
    await expect(emit('TestAction', { foo: 'bar' })).resolves.toBeUndefined();
  });

  it('forwards to the bound log with merged data shape', async () => {
    const log = vi.fn().mockResolvedValue();
    const fakeBinding = { log };
    const emit = createAuditEmitter(fakeBinding, console);
    await emit('SecretValueRead', { user: 'alice', key: 'X' });
    expect(log).toHaveBeenCalledWith('SecurityEvent', {
      data: { action: 'SecretValueRead', user: 'alice', key: 'X' }
    });
  });

  it('warns but does not throw if the log call rejects', async () => {
    const log = vi.fn().mockRejectedValue(new Error('boom'));
    const warn = vi.fn();
    const emit = createAuditEmitter({ log }, { warn });
    await expect(emit('X', { y: 1 })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('emit failed for X'));
  });
});
