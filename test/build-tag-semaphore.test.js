import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('GET /build/tag-semaphore', () => {
  it('returns a map object and buildAt with a 60s cache header', async () => {
    const { status, data, headers } = await project.get('/build/tag-semaphore');
    expect(status).toBe(200);
    expect(data).toHaveProperty('map');
    expect(typeof data.map).toBe('object');
    expect(data).toHaveProperty('buildAt');
    expect(headers['cache-control']).toContain('max-age=60');
  });
});
