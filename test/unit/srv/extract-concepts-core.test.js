import { describe, it, expect, vi } from 'vitest';
import { extractConceptsCore } from '../../../srv/lib/kg-extract.js';

describe('extractConceptsCore', () => {
  it('calls callModel with system + user + schema', async () => {
    const callModel = vi.fn().mockResolvedValue({
      verdict: { teaches: [], extends: [], prerequisites: [] },
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });
    const schema = { type: 'object' };
    const result = await extractConceptsCore({
      system: 'you are a test',
      user: 'extract from this',
      schema,
      callModel,
    });
    expect(callModel).toHaveBeenCalledWith({
      system: 'you are a test',
      user: 'extract from this',
      schema,
    });
    expect(result).toHaveProperty('verdict');
    expect(result).toHaveProperty('tokenUsage');
  });

  it('throws when callModel is not a function', async () => {
    await expect(extractConceptsCore({
      system: 's',
      user: 'u',
      schema: {},
      callModel: null,
    })).rejects.toThrow(/callModel/i);
  });
});
