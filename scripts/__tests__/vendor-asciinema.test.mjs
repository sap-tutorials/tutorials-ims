import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';

// Uses vi.mock to stub fetch and fs so the test runs offline.
// NOTE: vi.stubGlobal returns the `vi` object for chaining (not the mock),
// so we capture the mock fn separately before passing it to stubGlobal.
describe('vendor-asciinema', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('exits 1 and prints error when fetch returns non-ok', async () => {
    // Ensure sentinel check passes (returns false = not present) so we reach the fetch path.
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 404, statusText: 'Not Found' }));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { main } = await import('../vendor-asciinema.mjs?v=' + Date.now());
    await expect(main()).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleSpy.mock.calls.some(args => args[0].toString().includes('404'))).toBe(true);
  });

  it('skips download when sentinel file already present', async () => {
    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    const { main } = await import('../vendor-asciinema.mjs?v=' + Date.now());
    await main();
    expect(mockFetch).not.toHaveBeenCalled();
    existsSpy.mockRestore();
  });
});

