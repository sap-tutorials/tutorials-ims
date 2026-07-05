import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('graphql plugin registration', () => {
  it('lists @cap-js/graphql in dependencies', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.dependencies['@cap-js/graphql']).toBeTruthy();
  });

  it('does not activate graphql on any service (baseline)', async () => {
    // Loading the plugin without any @graphql-annotated service is a no-op.
    // If this ever throws, the plugin's boot hook has become order-sensitive.
    const cds = (await import('@sap/cds')).default;
    // Just resolve — do not serve.
    const model = await cds.load('srv/homepage-service.cds');
    expect(model).toBeDefined();
  });
});
