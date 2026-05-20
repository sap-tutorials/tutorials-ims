import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreate = vi.fn();
vi.mock('@sap-ai-sdk/foundation-models', () => ({
  AzureOpenAiEmbeddingClient: vi.fn().mockImplementation(function () {
    return { run: mockCreate };
  })
}));

const { embed } = await import('../../srv/lib/embedding-client.js');

beforeEach(() => mockCreate.mockReset());

describe('embedding-client', () => {
  it('returns vectors aligned with input order', async () => {
    mockCreate.mockResolvedValueOnce({
      data: [
        { embedding: [0.1, 0.2], index: 0 },
        { embedding: [0.3, 0.4], index: 1 }
      ]
    });
    const out = await embed(['hello', 'world'], 'text-embedding-3-small');
    expect(out).toHaveLength(2);
    expect(Array.from(out[0])).toEqual([expect.closeTo(0.1), expect.closeTo(0.2)]);
    expect(Array.from(out[1])).toEqual([expect.closeTo(0.3), expect.closeTo(0.4)]);
  });

  it('batches inputs over 100 at a time', async () => {
    mockCreate.mockResolvedValue({
      data: Array.from({ length: 100 }, (_, i) => ({ embedding: [i], index: i }))
    });
    const inputs = Array.from({ length: 250 }, (_, i) => `t${i}`);
    await embed(inputs, 'text-embedding-3-small');
    expect(mockCreate).toHaveBeenCalledTimes(3); // 100 + 100 + 50
  });

  it('retries on 429 and succeeds on third attempt', async () => {
    const err429 = Object.assign(new Error('rate limited'), { status: 429 });
    mockCreate
      .mockRejectedValueOnce(err429)
      .mockRejectedValueOnce(err429)
      .mockResolvedValueOnce({ data: [{ embedding: [1, 2], index: 0 }] });
    const out = await embed(['x'], 'text-embedding-3-small');
    expect(out).toHaveLength(1);
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  it('gives up after 3 retries on persistent 5xx', async () => {
    const err500 = Object.assign(new Error('server error'), { status: 503 });
    mockCreate
      .mockRejectedValueOnce(err500)
      .mockRejectedValueOnce(err500)
      .mockRejectedValueOnce(err500);
    await expect(embed(['x'], 'text-embedding-3-small')).rejects.toThrow();
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  it('does not retry on 4xx other than 429', async () => {
    const err400 = Object.assign(new Error('bad request'), { status: 400 });
    mockCreate.mockRejectedValueOnce(err400);
    await expect(embed(['x'], 'text-embedding-3-small')).rejects.toThrow();
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('returns [] for [] input without calling the API', async () => {
    const out = await embed([], 'text-embedding-3-small');
    expect(out).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
