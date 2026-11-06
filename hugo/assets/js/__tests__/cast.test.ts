// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Provide a minimal AsciinemaPlayer stub on window.
const mockCreate = vi.fn();
beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '';
  (window as unknown as Record<string, unknown>)['AsciinemaPlayer'] = { create: mockCreate };
  mockCreate.mockClear();
});

it('mounts player on .tut-cast elements in viewport', async () => {
  document.body.innerHTML = `
    <div class="tut-cast" data-tut-cast="https://example.com/demo.cast"
         data-rows="24" data-speed="1.5"></div>`;
  const { initCast } = await import('../cast.js');
  await initCast({ skipObserver: true });  // bypass IO for unit test
  expect(mockCreate).toHaveBeenCalledOnce();
  const [src, el, opts] = mockCreate.mock.calls[0];
  expect(src).toBe('https://example.com/demo.cast');
  expect(el).toBeInstanceOf(HTMLElement);
  expect(opts.rows).toBe(24);
  expect(opts.speed).toBe(1.5);
});

it('does not double-mount an already mounted element', async () => {
  document.body.innerHTML = `
    <div class="tut-cast" data-tut-cast="https://example.com/demo.cast"
         data-cast-mounted="true"></div>`;
  const { initCast } = await import('../cast.js');
  await initCast({ skipObserver: true });
  expect(mockCreate).not.toHaveBeenCalled();
});

it('falls back to immediate mount when IntersectionObserver absent', async () => {
  document.body.innerHTML = `
    <div class="tut-cast" data-tut-cast="https://example.com/demo.cast"></div>`;
  // Remove IO from window to simulate absent support.
  const origIO = (window as unknown as Record<string, unknown>)['IntersectionObserver'];
  delete (window as unknown as Record<string, unknown>)['IntersectionObserver'];
  const { initCast } = await import('../cast.js');
  await initCast({});
  expect(mockCreate).toHaveBeenCalledOnce();
  (window as unknown as Record<string, unknown>)['IntersectionObserver'] = origIO;
});

it('passes idle-limit as idleTimeLimit to player', async () => {
  document.body.innerHTML = `
    <div class="tut-cast" data-tut-cast="https://example.com/demo.cast"
         data-idle-limit="2"></div>`;
  const { initCast } = await import('../cast.js');
  await initCast({ skipObserver: true });
  const [, , opts] = mockCreate.mock.calls[0];
  expect(opts.idleTimeLimit).toBe(2);
});

it('removes the placeholder pre after mounting', async () => {
  document.body.innerHTML = `
    <div class="tut-cast" data-tut-cast="https://example.com/demo.cast">
      <pre class="tut-cast__placeholder">Loading…</pre>
    </div>`;
  const { initCast } = await import('../cast.js');
  await initCast({ skipObserver: true });
  expect(document.querySelector('.tut-cast__placeholder')).toBeNull();
});
