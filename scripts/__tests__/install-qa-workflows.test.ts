import { describe, it, expect } from 'vitest';
import { generateNotifyYaml, listContributionRepos } from '../install-qa-workflows';

describe('install-qa-workflows', () => {
  it('produces a valid yaml string', () => {
    const y = generateNotifyYaml();
    expect(y).toContain('event-type: tutorial-qa-updated');
  });
  it('listContributionRepos returns only -Contribution repos', async () => {
    const fakeFetch = async () => [
      { name: 'abap-core-development' },
      { name: 'abap-core-development-Contribution' }
    ];
    const repos = await listContributionRepos(fakeFetch as any);
    expect(repos).toEqual(['abap-core-development-Contribution']);
  });
});
