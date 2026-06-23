import { describe, it, expect, afterEach } from 'vitest';
import cds from '@sap/cds';

// cds.test boots the full CAP service in-memory (SQLite) so toolsForContext
// can read ChatSettings. The schema test below does not need a live service
// but it runs in the same file — cds.test is idempotent for multiple suites.
cds.test('serve', '--project', '.', '--in-memory');

import * as orchestrator from '../srv/lib/chat-orchestrator.js';
import { toolsForContext, dispatchTool } from '../srv/lib/chat-orchestrator.js';

describe('GET_DEVTOBERFEST_INFO_TOOL definition', () => {
  it('exports a JSON-schema function tool with the expected shape', () => {
    const tool = orchestrator.GET_DEVTOBERFEST_INFO_TOOL;
    expect(tool).toBeDefined();
    expect(tool.type).toBe('function');
    expect(tool.function.name).toBe('getDevtoberfestInfo');
    expect(typeof tool.function.description).toBe('string');
    expect(tool.function.description.length).toBeGreaterThan(40);

    const params = tool.function.parameters;
    expect(params.type).toBe('object');
    expect(params.properties.section.type).toBe('string');
    expect(params.properties.section.enum).toEqual([
      'all', 'event', 'terms', 'links', 'points', 'gameboard', 'activities', 'videos'
    ]);
    // Section is optional — handler defaults to 'all'.
    expect(params.required).toBeUndefined();
  });
});

const CHAT_SETTINGS_ID = '00000000-0000-0000-0000-00000000c8a7';

describe('toolsForContext — devtoberfest kind', () => {
  afterEach(async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await DELETE.from(ChatSettings).where({ ID: CHAT_SETTINGS_ID });
  });

  it("registers exactly [searchTutorials, getDevtoberfestInfo] when kind='devtoberfest'", async () => {
    const tools = await toolsForContext({ pageContext: { kind: 'devtoberfest' }, isAdmin: false });
    const names = tools.map(t => t.function?.name);
    expect(names).toEqual(['searchTutorials', 'getDevtoberfestInfo']);
  });

  it('suppresses all feature-flagged tools on devtoberfest pages even when their flags are on', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await UPSERT.into(ChatSettings).entries({
      ID: CHAT_SETTINGS_ID,
      ragEnabled: true,
      codeCheckEnabled: true,
      branchingEnabled: true,
      kgPathBetweenEnabled: true
    });

    const tools = await toolsForContext({ pageContext: { kind: 'devtoberfest' }, isAdmin: false });
    const names = tools.map(t => t.function?.name);
    expect(names).not.toContain('getRelevantSteps');
    expect(names).not.toContain('checkCode');
    expect(names).not.toContain('getBranchRecommendation');
    expect(names).not.toContain('findLearningPath');
    expect(names).not.toContain('getUserProgress');
  });

  it("regression: kind='tutorial' still gets the existing learner tool set", async () => {
    const tools = await toolsForContext({ pageContext: { kind: 'tutorial' }, isAdmin: false });
    const names = tools.map(t => t.function?.name);
    expect(names).toContain('searchTutorials');
    expect(names).toContain('getUserProgress');
    expect(names).not.toContain('getDevtoberfestInfo');
  });

  it("regression: kind='admin' with isAdmin=true still gets the admin tool set", async () => {
    const tools = await toolsForContext({ pageContext: { kind: 'admin' }, isAdmin: true });
    const names = tools.map(t => t.function?.name);
    expect(names).toContain('searchAdminDocs');
    expect(names).toContain('analyticsQuery');
    expect(names).toContain('generateAnalyticsQuery');
    expect(names).toContain('explainAnalyticsResult');
    expect(names).not.toContain('getDevtoberfestInfo');
  });
});

describe('dispatchTool — getDevtoberfestInfo route', () => {
  it('routes the tool name to the handler and returns a payload with event + generatedAt', async () => {
    const out = await dispatchTool('getDevtoberfestInfo', { section: 'event' }, null);
    expect(out).toBeDefined();
    expect(out.event).toBeDefined();
    expect(typeof out.event.status).toBe('string');
    expect(typeof out.generatedAt).toBe('string');
  });
});
