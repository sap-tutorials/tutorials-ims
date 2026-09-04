// test/admin-channel-submissions.test.js
import cds from '@sap/cds';
const project = cds.test('serve', '--project', '.', '--in-memory');
const NS = 'com.sap.developers.ims';
const adminAuth = { auth: { username: 'admin', password: 'admin' } };

async function seedSubmission(row) {
  const { ChannelSubmissions } = cds.entities(NS);
  const ID = cds.utils.uuid();
  await INSERT.into(ChannelSubmissions).entries({ ID, status: 'PENDING', ...row });
  return ID;
}
async function seedChannel(row) {
  const { Channels } = cds.entities(NS);
  const ID = cds.utils.uuid();
  await INSERT.into(Channels).entries({ ID, sourceId: `seed-${ID.slice(0, 8)}`, name: 'orig', url: 'https://orig', isPublished: true, status: 'Active', ...row });
  return ID;
}

describe('AdminService ChannelSubmissions moderation', () => {
  test('anonymous access to the queue is rejected 401', async () => {
    await expect(project.get('/admin/ChannelSubmissions')).rejects.toMatchObject({ response: { status: 401 } });
  });

  test('approve ADD inserts a published Channel and marks submission APPROVED', async () => {
    const id = await seedSubmission({ kind: 'ADD', proposed: JSON.stringify({ name: 'New Ch', url: 'https://new', ownerType: 'Community_Member', status: 'Archived', isPublished: false }) });
    await project.post(`/admin/ChannelSubmissions(${id})/AdminService.approve`, { note: 'ok' }, adminAuth);
    const { Channels, ChannelSubmissions } = cds.entities(NS);
    const ch = await SELECT.one.from(Channels).where({ name: 'New Ch' });
    expect(ch).toBeTruthy();
    expect(ch.isPublished).toBe(true);          // forced true, client "isPublished:false" ignored
    expect(ch.status).toBe('Active');           // forced Active, client "status:Archived" ignored
    expect(ch.sourceId).toMatch(/^community-/);
    const sub = await SELECT.one.from(ChannelSubmissions).where({ ID: id });
    expect(sub.status).toBe('APPROVED');
    expect(sub.reviewNote).toBe('ok');
    expect(sub.reviewerId).toBe('admin');         // req.user.id stamped from auth
  });

  test('approve EDIT patches only whitelisted fields on the target channel', async () => {
    const chId = await seedChannel({ name: 'orig', purpose: 'old' });
    const id = await seedSubmission({ kind: 'EDIT', targetChannel_ID: chId, proposed: JSON.stringify({ purpose: 'new purpose', contentHash: 'HACK', sourceId: 'HACK' }) });
    await project.post(`/admin/ChannelSubmissions(${id})/AdminService.approve`, { note: '' }, adminAuth);
    const { Channels } = cds.entities(NS);
    const ch = await SELECT.one.from(Channels).where({ ID: chId });
    expect(ch.purpose).toBe('new purpose');
    expect(ch.contentHash).not.toBe('HACK');    // non-whitelisted key ignored
    expect(ch.sourceId).not.toBe('HACK');
  });

  test('approve REMOVE unpublishes the target channel', async () => {
    const chId = await seedChannel({ name: 'togo' });
    const id = await seedSubmission({ kind: 'REMOVE', targetChannel_ID: chId });
    await project.post(`/admin/ChannelSubmissions(${id})/AdminService.approve`, { note: 'spam' }, adminAuth);
    const { Channels } = cds.entities(NS);
    const ch = await SELECT.one.from(Channels).where({ ID: chId });
    expect(ch.isPublished).toBe(false);
  });

  test('reject records REJECTED + note without touching Channels', async () => {
    const id = await seedSubmission({ kind: 'ADD', proposed: '{"name":"nope","url":"https://nope"}' });
    await project.post(`/admin/ChannelSubmissions(${id})/AdminService.reject`, { note: 'off-topic' }, adminAuth);
    const { Channels, ChannelSubmissions } = cds.entities(NS);
    const sub = await SELECT.one.from(ChannelSubmissions).where({ ID: id });
    expect(sub.status).toBe('REJECTED');
    expect(sub.reviewNote).toBe('off-topic');
    const ch = await SELECT.one.from(Channels).where({ name: 'nope' });
    expect(ch).toBeUndefined();
  });

  test('approving an already-reviewed submission is rejected 400', async () => {
    const id = await seedSubmission({ kind: 'REMOVE', targetChannel_ID: await seedChannel({ name: 'x' }), status: 'APPROVED' });
    await expect(
      project.post(`/admin/ChannelSubmissions(${id})/AdminService.approve`, { note: '' }, adminAuth),
    ).rejects.toMatchObject({ response: { status: 400 } });
  });

  test('rejecting an already-reviewed submission is rejected 400', async () => {
    const id = await seedSubmission({ kind: 'ADD', proposed: '{}', status: 'REJECTED' });
    await expect(
      project.post(`/admin/ChannelSubmissions(${id})/AdminService.reject`, { note: '' }, adminAuth),
    ).rejects.toMatchObject({ response: { status: 400 } });
  });

  test('approve unknown submission ID returns 404', async () => {
    const fakeId = cds.utils.uuid();
    await expect(
      project.post(`/admin/ChannelSubmissions(${fakeId})/AdminService.approve`, { note: '' }, adminAuth),
    ).rejects.toMatchObject({ response: { status: 404 } });
  });

  test('reject unknown submission ID returns 404', async () => {
    const fakeId = cds.utils.uuid();
    await expect(
      project.post(`/admin/ChannelSubmissions(${fakeId})/AdminService.reject`, { note: '' }, adminAuth),
    ).rejects.toMatchObject({ response: { status: 404 } });
  });
});
