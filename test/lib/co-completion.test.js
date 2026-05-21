import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'

cds.test('serve', '--project', '.', '--in-memory')

describe('co-completion aggregator', () => {
  beforeAll(async () => {
    const { Tutorials, TaskRecords, Users } = cds.entities('com.sap.developers.ims')
    await DELETE.from(TaskRecords)
    await DELETE.from(Users)
    await DELETE.from(Tutorials)
    await INSERT.into(Tutorials).entries([
      { ID: 'cc-t1', legacyId: 9001, slug: 'alpha', title: 'Alpha', status: 'ACTIVE' },
      { ID: 'cc-t2', legacyId: 9002, slug: 'beta',  title: 'Beta',  status: 'ACTIVE' },
      { ID: 'cc-t3', legacyId: 9003, slug: 'gamma', title: 'Gamma', status: 'ACTIVE' },
    ])
    await INSERT.into(Users).entries([
      { ID: 'cc-u1', legacyId: 9101, uuid: '00000000-0000-0000-0000-000000009101' },
      { ID: 'cc-u2', legacyId: 9102, uuid: '00000000-0000-0000-0000-000000009102' },
    ])
    await INSERT.into(TaskRecords).entries([
      { ID: 'cc-r1', user_ID: 'cc-u1', taskType: 'TUTORIAL', taskLegacyId: 9001, status: 'COMPLETED' },
      { ID: 'cc-r2', user_ID: 'cc-u1', taskType: 'TUTORIAL', taskLegacyId: 9002, status: 'COMPLETED' },
      { ID: 'cc-r3', user_ID: 'cc-u2', taskType: 'TUTORIAL', taskLegacyId: 9001, status: 'COMPLETED' },
      { ID: 'cc-r4', user_ID: 'cc-u2', taskType: 'TUTORIAL', taskLegacyId: 9003, status: 'COMPLETED' },
    ])
  })

  it('counts co-completion pairs symmetrically', async () => {
    const { computeCoCompletions } = await import('../../srv/lib/co-completion.js')
    const result = await computeCoCompletions({ force: true })
    // u1 completed alpha+beta, u2 completed alpha+gamma
    // alpha co-occurs with beta (1 user) and gamma (1 user)
    expect(result.alpha).toEqual(expect.arrayContaining([
      { slug: 'beta', score: 1 },
      { slug: 'gamma', score: 1 },
    ]))
    expect(result.beta).toEqual([{ slug: 'alpha', score: 1 }])
    expect(result.gamma).toEqual([{ slug: 'alpha', score: 1 }])
  })
})
