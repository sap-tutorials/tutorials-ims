// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { createPipChannel } from './pip-channel';

describe('pip-channel', () => {
  it('drops messages from its own senderId', async () => {
    const main = createPipChannel('demo-slug', 'main');
    const handler = vi.fn();
    main.on(handler);
    main.send({ type: 'pip:stepChange', stepIndex: 3 });
    await new Promise(r => setTimeout(r, 10));
    expect(handler).not.toHaveBeenCalled();
    main.close();
  });

  it('delivers messages from a different senderId on the same channel', async () => {
    const a = createPipChannel('demo-slug', 'main');
    const b = createPipChannel('demo-slug', 'pip');
    const handler = vi.fn();
    a.on(handler);
    b.send({ type: 'pip:stepChange', stepIndex: 5 });
    await new Promise(r => setTimeout(r, 10));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({
      type: 'pip:stepChange',
      stepIndex: 5,
      source: 'pip',
    });
    expect(typeof handler.mock.calls[0][0].senderId).toBe('string');
    a.close();
    b.close();
  });

  it('isolates channels by slug', async () => {
    const a = createPipChannel('slug-a', 'main');
    const b = createPipChannel('slug-b', 'pip');
    const handler = vi.fn();
    a.on(handler);
    b.send({ type: 'pip:stepChange', stepIndex: 1 });
    await new Promise(r => setTimeout(r, 10));
    expect(handler).not.toHaveBeenCalled();
    a.close();
    b.close();
  });

  it('returns an unsubscribe function from on()', async () => {
    const a = createPipChannel('demo-slug-2', 'main');
    const b = createPipChannel('demo-slug-2', 'pip');
    const handler = vi.fn();
    const off = a.on(handler);
    off();
    b.send({ type: 'pip:stepChange', stepIndex: 1 });
    await new Promise(r => setTimeout(r, 10));
    expect(handler).not.toHaveBeenCalled();
    a.close();
    b.close();
  });
});
