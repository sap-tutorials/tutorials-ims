import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  fetchAllHelpDocs,
  _setMockOrchestrator,
  _resetForTests,
} from '../../../srv/lib/help-docs/index.js';

// Shared body — identical (title, description, product, section) tuple across sources
// will collide contentHash. Per spec §4.2.5 (revised): source is deliberately EXCLUDED
// from the hash so cross-source rows CAN collide — that's the whole point of dedupe.
// Source-precedence then picks the winner (§6.2: cap > ui5 > help).

const IDENTICAL_TITLE = 'CAP Handlers';
const IDENTICAL_BODY = 'Register a handler that fires before entity creation.';
const IDENTICAL_PRODUCT = 'cap';
const IDENTICAL_SECTION = null;

function baseRow(source, sourceId) {
  return {
    source,
    sourceId,
    title: IDENTICAL_TITLE,
    description: IDENTICAL_BODY,
    url: `https://example.test/${source}/${sourceId}`,
    product: IDENTICAL_PRODUCT,
    section: IDENTICAL_SECTION,
  };
}

function distinctRow(source, sourceId, uniqueBody) {
  return {
    source,
    sourceId,
    title: IDENTICAL_TITLE,
    description: uniqueBody,
    url: `https://example.test/${source}/${sourceId}`,
    product: IDENTICAL_PRODUCT,
    section: IDENTICAL_SECTION,
  };
}

describe('help-docs dedupe (spec §6.4)', () => {
  beforeEach(() => {
    _resetForTests();
  });

  it('drops help-sap-com when cap-cloud-sap has same contentHash (cap wins by precedence)', async () => {
    _setMockOrchestrator(async () => ({
      rows: [
        baseRow('help-sap-com', 'btp/sap-business-technology-platform/handlers'),
        baseRow('cap-cloud-sap', 'docs/node.js/handlers'),
      ],
      perSource: {},
    }));
    const { rows } = await fetchAllHelpDocs({ apiKey: 'fake' });
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('cap-cloud-sap');
  });

  it('drops help-sap-com when ui5-sap-com has same contentHash (ui5 wins by precedence)', async () => {
    _setMockOrchestrator(async () => ({
      rows: [
        baseRow('help-sap-com', 'btp/ui5-topic/x'),
        baseRow('ui5-sap-com', 'topic/abc123'),
      ],
      perSource: {},
    }));
    const { rows } = await fetchAllHelpDocs({ apiKey: 'fake' });
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('ui5-sap-com');
  });

  it('drops ui5-sap-com when cap-cloud-sap has same contentHash (cap > ui5)', async () => {
    _setMockOrchestrator(async () => ({
      rows: [
        baseRow('cap-cloud-sap', 'docs/node.js/handlers'),
        baseRow('ui5-sap-com', 'topic/def456'),
      ],
      perSource: {},
    }));
    const { rows } = await fetchAllHelpDocs({ apiKey: 'fake' });
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('cap-cloud-sap');
  });

  it('keeps distinct-content rows even when titles overlap fuzzily (hash requires exact material match)', async () => {
    _setMockOrchestrator(async () => ({
      rows: [
        distinctRow('help-sap-com', '/docs/a', 'help.sap.com content unique to this row.'),
        distinctRow('cap-cloud-sap', 'docs/handlers.md', 'cap.cloud.sap content genuinely different.'),
      ],
      perSource: {},
    }));
    const { rows } = await fetchAllHelpDocs({ apiKey: 'fake' });
    expect(rows).toHaveLength(2);   // both survive — different contentHash
  });

  it('logs dropped rows at INFO with dupeOf/chosenSource/droppedSource', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    _setMockOrchestrator(async () => ({
      rows: [
        baseRow('help-sap-com', 'btp/handlers'),
        baseRow('cap-cloud-sap', 'docs/node.js/handlers'),
      ],
      perSource: {},
    }));
    await fetchAllHelpDocs({ apiKey: 'fake' });
    const call = infoSpy.mock.calls.find(args => String(args[0]).includes('help-docs.dedupe'));
    expect(call).toBeDefined();
    infoSpy.mockRestore();
  });
});
