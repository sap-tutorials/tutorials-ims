import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

// Issue #2887: App Space parallel-paths — buildPathSegments must emit a nested
// segment structure (linear / parallel-any / fork lanes) instead of a flat
// items array. This test validates the new `segments` field on each path object
// returned by getAppSpaceProgress.
//
// Scenario A ("fork event"): a path with three distinct itemOrders:
//   Order 10  — one TUTORIAL (Setup)            → linear segment
//   Order 20  — two GROUPs (MCP w/ prize; Agents) → fork segment, 2 lanes
//   Order 30  — one CHECKPOINT                  → linear segment
//
// Scenario B ("lone-group event"): a path whose only item is a single GROUP
//   → linear segment whose items are the group's expanded tutorials (no lane wrapper)

const project = cds.test('serve', '--project', '.', '--in-memory');

// ─── Scenario A: fork event ──────────────────────────────────────────────────
const FORK_EVENT_ID   = 10008001;
const FORK_MISSION_ID = '11111111-2887-aaaa-0000-000000000001';
const FORK_EVENT_UUID = 'eeeeeeee-2887-aaaa-0000-000000000001';
const FORK_PATH_ID    = '22222222-2887-aaaa-0000-000000000001';

// Groups for the fork
const GRP_MCP_ID    = '33333333-2887-aaaa-0000-000000000001';
const GRP_AGENTS_ID = '33333333-2887-aaaa-0000-000000000002';

// Prize attached to the MCP group path item
const PRIZE_ID = '44444444-2887-aaaa-0000-000000000001';

// Tutorials for MCP group
const TUT_MCP_A  = { ID: 'cccccccc-2887-aaaa-0000-000000000001', legacyId: 10008010, slug: 'mcp-tut-a', title: 'MCP Tutorial A' };
const TUT_MCP_B  = { ID: 'cccccccc-2887-aaaa-0000-000000000002', legacyId: 10008011, slug: 'mcp-tut-b', title: 'MCP Tutorial B' };
// Tutorials for Agents group
const TUT_AGT_A  = { ID: 'cccccccc-2887-aaaa-0000-000000000003', legacyId: 10008012, slug: 'agents-tut-a', title: 'Agents Tutorial A' };
// Setup tutorial (Order 10)
const TUT_SETUP  = { ID: 'cccccccc-2887-aaaa-0000-000000000004', legacyId: 10008013, slug: 'setup-tut', title: 'Setup Tutorial' };

// ─── Scenario B: lone-group event ────────────────────────────────────────────
const LONE_EVENT_ID   = 10008002;
const LONE_MISSION_ID = '11111111-2887-aaaa-0000-000000000002';
const LONE_EVENT_UUID = 'eeeeeeee-2887-aaaa-0000-000000000002';
const LONE_PATH_ID    = '22222222-2887-aaaa-0000-000000000002';
const LONE_GRP_ID     = '33333333-2887-aaaa-0000-000000000003';
const TUT_LONE_A = { ID: 'cccccccc-2887-aaaa-0000-000000000005', legacyId: 10008020, slug: 'lone-grp-a', title: 'Lone Group Tut A' };
const TUT_LONE_B = { ID: 'cccccccc-2887-aaaa-0000-000000000006', legacyId: 10008021, slug: 'lone-grp-b', title: 'Lone Group Tut B' };

describe('App-Space segments: fork lanes + synthetic prize CHECKPOINT + lone-GROUP linear (#2887)', () => {
  beforeAll(async () => {
    const {
      Events, Missions, CompletionPaths, CompletionPathItems,
      Groups, GroupPathItems, Tutorials, Prizes
    } = cds.entities('com.sap.developers.ims');

    // ── Tutorials ──────────────────────────────────────────────────────────
    await INSERT.into(Tutorials).entries([
      TUT_SETUP, TUT_MCP_A, TUT_MCP_B, TUT_AGT_A,
      TUT_LONE_A, TUT_LONE_B,
    ]);

    // ── Groups ─────────────────────────────────────────────────────────────
    await INSERT.into(Groups).entries([
      { ID: GRP_MCP_ID,    legacyId: 10008030, title: 'MCP',    slug: 'grp-mcp',    published: true },
      { ID: GRP_AGENTS_ID, legacyId: 10008031, title: 'Agents', slug: 'grp-agents', published: true },
      { ID: LONE_GRP_ID,   legacyId: 10008032, title: 'Lone Group', slug: 'grp-lone', published: true },
    ]);

    // ── GroupPathItems ─────────────────────────────────────────────────────
    await INSERT.into(GroupPathItems).entries([
      // MCP group children
      { ID: 'ffffffff-2887-aaaa-0000-000000000001', group_ID: GRP_MCP_ID, tutorial_ID: TUT_MCP_A.ID, itemOrder: 1 },
      { ID: 'ffffffff-2887-aaaa-0000-000000000002', group_ID: GRP_MCP_ID, tutorial_ID: TUT_MCP_B.ID, itemOrder: 2 },
      // Agents group children
      { ID: 'ffffffff-2887-aaaa-0000-000000000003', group_ID: GRP_AGENTS_ID, tutorial_ID: TUT_AGT_A.ID, itemOrder: 1 },
      // Lone group children
      { ID: 'ffffffff-2887-aaaa-0000-000000000004', group_ID: LONE_GRP_ID, tutorial_ID: TUT_LONE_A.ID, itemOrder: 1 },
      { ID: 'ffffffff-2887-aaaa-0000-000000000005', group_ID: LONE_GRP_ID, tutorial_ID: TUT_LONE_B.ID, itemOrder: 2 },
    ]);

    // ── Prizes ─────────────────────────────────────────────────────────────
    await INSERT.into(Prizes).entries([
      { ID: PRIZE_ID, legacyId: 10008040, name: 'MCP Prize', event_ID: FORK_EVENT_UUID },
    ]);

    // ── Scenario A: fork mission + event ───────────────────────────────────
    await INSERT.into(Missions).entries({
      ID: FORK_MISSION_ID, legacyId: 10008050, title: 'Fork Mission',
      slug: 'fork-mission', description: 'A fork mission', published: true, event_ID: null,
    });
    await INSERT.into(Events).entries({
      ID: FORK_EVENT_UUID, legacyId: FORK_EVENT_ID,
      name: 'Fork Test Event', eventType: 'OTHER', mission_ID: FORK_MISSION_ID,
    });
    await INSERT.into(CompletionPaths).entries({
      ID: FORK_PATH_ID, legacyId: 10008060, name: 'Fork Path',
      mission_ID: FORK_MISSION_ID, description: 'The fork path',
    });
    await INSERT.into(CompletionPathItems).entries([
      // Order 10: single TUTORIAL (linear)
      { ID: 'dddddddd-2887-aaaa-0000-000000000001', path_ID: FORK_PATH_ID, itemOrder: 10,
        taskType: 'TUTORIAL', taskLegacyId: null, tutorial_ID: TUT_SETUP.ID },
      // Order 20: GROUP MCP (with prize) — fork lane 1
      { ID: 'dddddddd-2887-aaaa-0000-000000000002', path_ID: FORK_PATH_ID, itemOrder: 20,
        taskType: 'GROUP', taskLegacyId: null, group_ID: GRP_MCP_ID, prize_ID: PRIZE_ID },
      // Order 20: GROUP Agents (no prize) — fork lane 2
      { ID: 'dddddddd-2887-aaaa-0000-000000000003', path_ID: FORK_PATH_ID, itemOrder: 20,
        taskType: 'GROUP', taskLegacyId: null, group_ID: GRP_AGENTS_ID },
      // Order 30: single CHECKPOINT (linear)
      { ID: 'dddddddd-2887-aaaa-0000-000000000004', path_ID: FORK_PATH_ID, itemOrder: 30,
        taskType: 'CHECKPOINT', taskLegacyId: 10008070, checkpointTitle: 'Final Check' },
    ]);

    // ── Scenario B: lone-group mission + event ─────────────────────────────
    await INSERT.into(Missions).entries({
      ID: LONE_MISSION_ID, legacyId: 10008051, title: 'Lone Group Mission',
      slug: 'lone-group-mission', description: 'Lone group', published: true, event_ID: null,
    });
    await INSERT.into(Events).entries({
      ID: LONE_EVENT_UUID, legacyId: LONE_EVENT_ID,
      name: 'Lone Group Test Event', eventType: 'OTHER', mission_ID: LONE_MISSION_ID,
    });
    await INSERT.into(CompletionPaths).entries({
      ID: LONE_PATH_ID, legacyId: 10008061, name: 'Lone Group Path',
      mission_ID: LONE_MISSION_ID, description: 'Lone group path',
    });
    await INSERT.into(CompletionPathItems).entries([
      // Single GROUP at Order 10 (lone-GROUP case → linear, expands inline)
      { ID: 'dddddddd-2887-aaaa-0000-000000000005', path_ID: LONE_PATH_ID, itemOrder: 10,
        taskType: 'GROUP', taskLegacyId: null, group_ID: LONE_GRP_ID },
    ]);
  });

  afterAll(async () => {
    const {
      Events, Missions, CompletionPaths, CompletionPathItems,
      Groups, GroupPathItems, Tutorials, Prizes
    } = cds.entities('com.sap.developers.ims');
    await DELETE.from(CompletionPathItems).where({
      path_ID: { in: [FORK_PATH_ID, LONE_PATH_ID] }
    });
    await DELETE.from(CompletionPaths).where({ ID: { in: [FORK_PATH_ID, LONE_PATH_ID] } });
    await DELETE.from(Events).where({ legacyId: { in: [FORK_EVENT_ID, LONE_EVENT_ID] } });
    await DELETE.from(Missions).where({ ID: { in: [FORK_MISSION_ID, LONE_MISSION_ID] } });
    await DELETE.from(GroupPathItems).where({
      group_ID: { in: [GRP_MCP_ID, GRP_AGENTS_ID, LONE_GRP_ID] }
    });
    await DELETE.from(Groups).where({ ID: { in: [GRP_MCP_ID, GRP_AGENTS_ID, LONE_GRP_ID] } });
    await DELETE.from(Prizes).where({ ID: PRIZE_ID });
    await DELETE.from(Tutorials).where({
      ID: { in: [TUT_SETUP.ID, TUT_MCP_A.ID, TUT_MCP_B.ID, TUT_AGT_A.ID, TUT_LONE_A.ID, TUT_LONE_B.ID] }
    });
  });

  // ── Scenario A tests ──────────────────────────────────────────────────────

  it('fork path has 3 segments with kinds [linear, fork, linear]', async () => {
    const { data } = await project.get(`/api/getAppSpaceProgress(eventLegacyId=${FORK_EVENT_ID})`);
    const path = data.paths.find(p => p.id === 10008060);
    expect(path).toBeDefined();
    expect(path.segments).toBeDefined();
    expect(path.segments).toHaveLength(3);
    expect(path.segments.map(s => s.kind)).toEqual(['linear', 'fork', 'linear']);
  });

  it('fork segment has 2 lanes labeled MCP and Agents (from Groups.title)', async () => {
    const { data } = await project.get(`/api/getAppSpaceProgress(eventLegacyId=${FORK_EVENT_ID})`);
    const path = data.paths.find(p => p.id === 10008060);
    const forkSeg = path.segments.find(s => s.kind === 'fork');
    expect(forkSeg).toBeDefined();
    expect(forkSeg.lanes).toHaveLength(2);
    const labels = forkSeg.lanes.map(l => l.label);
    expect(labels).toContain('MCP');
    expect(labels).toContain('Agents');
  });

  it('MCP lane contains its child tutorials', async () => {
    const { data } = await project.get(`/api/getAppSpaceProgress(eventLegacyId=${FORK_EVENT_ID})`);
    const path = data.paths.find(p => p.id === 10008060);
    const forkSeg = path.segments.find(s => s.kind === 'fork');
    const mcpLane = forkSeg.lanes.find(l => l.label === 'MCP');
    expect(mcpLane).toBeDefined();
    const tutTitles = mcpLane.items.filter(i => i.type === 'TUTORIAL').map(i => i.title);
    expect(tutTitles).toContain(TUT_MCP_A.title);
    expect(tutTitles).toContain(TUT_MCP_B.title);
  });

  it('MCP lane ends with a synthetic CHECKPOINT (from prize_ID)', async () => {
    const { data } = await project.get(`/api/getAppSpaceProgress(eventLegacyId=${FORK_EVENT_ID})`);
    const path = data.paths.find(p => p.id === 10008060);
    const forkSeg = path.segments.find(s => s.kind === 'fork');
    const mcpLane = forkSeg.lanes.find(l => l.label === 'MCP');
    const lastItem = mcpLane.items[mcpLane.items.length - 1];
    expect(lastItem.type).toBe('CHECKPOINT');
  });

  it('Agents lane has no synthetic CHECKPOINT (no prize)', async () => {
    const { data } = await project.get(`/api/getAppSpaceProgress(eventLegacyId=${FORK_EVENT_ID})`);
    const path = data.paths.find(p => p.id === 10008060);
    const forkSeg = path.segments.find(s => s.kind === 'fork');
    const agentsLane = forkSeg.lanes.find(l => l.label === 'Agents');
    expect(agentsLane).toBeDefined();
    expect(agentsLane.items.every(i => i.type !== 'CHECKPOINT')).toBe(true);
  });

  it('linear segment at Order 10 has the Setup tutorial', async () => {
    const { data } = await project.get(`/api/getAppSpaceProgress(eventLegacyId=${FORK_EVENT_ID})`);
    const path = data.paths.find(p => p.id === 10008060);
    const setupSeg = path.segments.find(s => s.order === 10);
    expect(setupSeg.kind).toBe('linear');
    expect(setupSeg.items).toHaveLength(1);
    expect(setupSeg.items[0].title).toBe(TUT_SETUP.title);
  });

  it('linear segment at Order 30 has the CHECKPOINT', async () => {
    const { data } = await project.get(`/api/getAppSpaceProgress(eventLegacyId=${FORK_EVENT_ID})`);
    const path = data.paths.find(p => p.id === 10008060);
    const cpSeg = path.segments.find(s => s.order === 30);
    expect(cpSeg.kind).toBe('linear');
    expect(cpSeg.items).toHaveLength(1);
    expect(cpSeg.items[0].type).toBe('CHECKPOINT');
    expect(cpSeg.items[0].title).toBe('Final Check');
  });

  it('flat items array is still present (backwards compat)', async () => {
    const { data } = await project.get(`/api/getAppSpaceProgress(eventLegacyId=${FORK_EVENT_ID})`);
    const path = data.paths.find(p => p.id === 10008060);
    expect(Array.isArray(path.items)).toBe(true);
    // items should contain the tutorials (flat, existing behavior)
    expect(path.items.length).toBeGreaterThan(0);
  });

  // ── Scenario B: lone GROUP → linear (no lane wrapper) ────────────────────

  it('lone GROUP at an order produces a linear segment with expanded tutorials (no lane wrapper)', async () => {
    const { data } = await project.get(`/api/getAppSpaceProgress(eventLegacyId=${LONE_EVENT_ID})`);
    const path = data.paths.find(p => p.id === 10008061);
    expect(path).toBeDefined();
    expect(path.segments).toBeDefined();
    expect(path.segments).toHaveLength(1);
    const seg = path.segments[0];
    expect(seg.kind).toBe('linear');
    // Linear segment must have items array (not lanes)
    expect(seg.items).toBeDefined();
    expect(seg.lanes).toBeUndefined();
    // Items must be the group's expanded tutorials
    const titles = seg.items.map(i => i.title);
    expect(titles).toContain(TUT_LONE_A.title);
    expect(titles).toContain(TUT_LONE_B.title);
    // No GROUP cards, only TUTORIAL cards
    expect(seg.items.every(i => i.type === 'TUTORIAL')).toBe(true);
  });
});
