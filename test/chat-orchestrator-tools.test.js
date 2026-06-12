import { describe, it, expect, afterEach } from 'vitest';
import cds from '@sap/cds';
import { toolsForContext } from '../srv/lib/chat-orchestrator.js';

const project = cds.test('serve', '--project', '.', '--in-memory');
const CHAT_SETTINGS_ID = '00000000-0000-0000-0000-00000000c8a7';

describe('toolsForContext — getBranchRecommendation registration', () => {
  afterEach(async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await DELETE.from(ChatSettings).where({ ID: CHAT_SETTINGS_ID });
  });

  it('registers getBranchRecommendation when branchingEnabled=true', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await UPSERT.into(ChatSettings).entries({ ID: CHAT_SETTINGS_ID, branchingEnabled: true });

    const tools = await toolsForContext({ pageContext: { kind: 'tutorial' }, isAdmin: false });
    const names = tools.map(t => t.function?.name);
    expect(names).toContain('getBranchRecommendation');
  });

  it('does NOT register getBranchRecommendation when branchingEnabled=false', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await UPSERT.into(ChatSettings).entries({ ID: CHAT_SETTINGS_ID, branchingEnabled: false });

    const tools = await toolsForContext({ pageContext: { kind: 'tutorial' }, isAdmin: false });
    const names = tools.map(t => t.function?.name);
    expect(names).not.toContain('getBranchRecommendation');
  });
});
