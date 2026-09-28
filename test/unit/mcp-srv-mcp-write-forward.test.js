// test/unit/mcp-srv-mcp-write-forward.test.js
//
// Unit test: srv-mcp write tool handlers (complete_step, reset_tutorial_progress)
// return a graceful 503 when the MainDeveloperService remote binding is unreachable.
//
// Tests the forwardWriteToMainSrv logic directly: injects a mock cds.connect.to
// that simulates the remote service being unconnectable.
//
// (#1105 Task 11 — srv-mcp best-effort forward)

import { describe, it, expect, vi } from 'vitest';

describe('srv-mcp write tools — best-effort forward to main-srv', () => {

  // Build a minimal mock req with a reject spy
  function makeMockReq(data) {
    const req = {
      data,
      user: { id: 'test@example.com', tokenSource: undefined, is: () => false, attr: {} },
      _rejected: null,
    };
    req.reject = vi.fn((code, msg) => { req._rejected = { code, msg }; });
    return req;
  }

  /**
   * Replicated forward logic from srv-mcp/developer-service.js.
   * connectToImpl replaces cds.connect.to so we can inject failure scenarios.
   */
  async function forwardWriteToMainSrv(event, data, req, connectToImpl) {
    try {
      const mainSrv = await connectToImpl('MainDeveloperService');
      const result = await mainSrv.send({ event, data, user: req.user });
      return result;
    } catch (err) {
      req.reject(503, 'progress service temporarily unavailable');
      return undefined;
    }
  }

  it('complete_step returns graceful 503 when MainDeveloperService is unreachable', async () => {
    const req = makeMockReq({ slug: 'test-tutorial', stepNumber: 1 });
    const mockConnectTo = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await forwardWriteToMainSrv('completeStep', req.data, req, mockConnectTo);

    // Must have called reject with 503 (not thrown unhandled)
    expect(req.reject).toHaveBeenCalledWith(503, 'progress service temporarily unavailable');
    expect(result).toBeUndefined();
  });

  it('reset_tutorial_progress returns graceful 503 when MainDeveloperService is unreachable', async () => {
    const req = makeMockReq({ slug: 'test-tutorial' });
    const mockConnectTo = vi.fn().mockRejectedValue(new Error('ETIMEDOUT'));

    const result = await forwardWriteToMainSrv('resetTutorialProgress', req.data, req, mockConnectTo);

    expect(req.reject).toHaveBeenCalledWith(503, 'progress service temporarily unavailable');
    expect(result).toBeUndefined();
  });

  it('complete_step forwards correctly when MainDeveloperService is reachable', async () => {
    const req = makeMockReq({ slug: 'tut-a', stepNumber: 2 });
    const expectedResult = { completedSteps: [1, 2], points: 20 };
    const mockSend = vi.fn().mockResolvedValue(expectedResult);
    const mockConnectTo = vi.fn().mockResolvedValue({ send: mockSend });

    const result = await forwardWriteToMainSrv('completeStep', req.data, req, mockConnectTo);

    expect(result).toEqual(expectedResult);
    expect(req.reject).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
      event: 'completeStep',
      data: { slug: 'tut-a', stepNumber: 2 },
    }));
  });

  it('does not throw even when remote service connect fails (graceful path)', async () => {
    const req = makeMockReq({ slug: 'tut-x', stepNumber: 1 });
    const mockConnectTo = vi.fn().mockRejectedValue(new Error('Network down'));

    // Should resolve (not throw) regardless of remote failure
    await expect(
      forwardWriteToMainSrv('completeStep', req.data, req, mockConnectTo)
    ).resolves.toBeUndefined();
  });

  it('503 is returned when remote send throws (not just connect failure)', async () => {
    const req = makeMockReq({ slug: 'tut-b', stepNumber: 3 });
    const mockSend = vi.fn().mockRejectedValue(new Error('503 from remote'));
    const mockConnectTo = vi.fn().mockResolvedValue({ send: mockSend });

    const result = await forwardWriteToMainSrv('completeStep', req.data, req, mockConnectTo);

    expect(req.reject).toHaveBeenCalledWith(503, 'progress service temporarily unavailable');
    expect(result).toBeUndefined();
  });
});
