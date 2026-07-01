import { describe, it, expect } from 'vitest';
import { canonicalizeHelpDocPath } from '../../../srv/lib/help-docs/index.js';

describe('help-doc slug canonicalization (spec §4.1)', () => {
  it('help-sap-com URL path → hd-help-sap-com__docs__btp__...', () => {
    const slug = canonicalizeHelpDocPath('help-sap-com', '/docs/btp/sap-business-technology-platform/getting-started');
    expect(slug).toBe('hd-help-sap-com____docs__btp__sap-business-technology-platform__getting-started');
    // Note: the leading '/' becomes '__' (not stripped) per §4.1's stateless-rule
    // canonicalization; §4.1 doesn't require leading-slash stripping and adding
    // it would create special-cases. Consumers (fetchers) pass sourceIds that
    // are already leading-slash-free by convention.
  });

  it('cap-cloud-sap blob path → hd-cap-cloud-sap__docs__node_js__handlers', () => {
    const slug = canonicalizeHelpDocPath('cap-cloud-sap', 'docs/node.js/handlers.md');
    expect(slug).toBe('hd-cap-cloud-sap__docs__node_js__handlers_md');
  });

  it('ui5-sap-com topic id → hd-ui5-sap-com__topic__<id>', () => {
    const slug = canonicalizeHelpDocPath('ui5-sap-com', 'topic/91f0652b6f4fc0cec4cb8d5b4a1e6e6d');
    expect(slug).toBe('hd-ui5-sap-com__topic__91f0652b6f4fc0cec4cb8d5b4a1e6e6d');
  });

  it('lowercases mixed-case input (spec §4.1: slug is case-stable)', () => {
    const slug = canonicalizeHelpDocPath('cap-cloud-sap', 'Docs/BTP/Getting-Started.md');
    expect(slug).toBe('hd-cap-cloud-sap__docs__btp__getting-started_md');
  });

  it('truncates deterministically at 150 chars (spec §4.1 ceiling)', () => {
    const long = 'docs/' + 'x'.repeat(200);
    const slug = canonicalizeHelpDocPath('help-sap-com', long);
    expect(slug.length).toBeLessThanOrEqual(150);
    // Deterministic same-input-same-output — critical because slug is the
    // primary key for upserts. Rerunning must produce the same slug.
    expect(canonicalizeHelpDocPath('help-sap-com', long)).toBe(slug);
  });
});
