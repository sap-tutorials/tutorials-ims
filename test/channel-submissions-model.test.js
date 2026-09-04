import cds from '@sap/cds';
const project = cds.test('serve', '--project', '.', '--in-memory');
const NS = 'com.sap.developers.ims';
const linked = () => cds.linked(cds.model).entities(NS);

describe('ChannelSubmissions model', () => {
  test('entity exists with cuid + managed + review fields', () => {
    const e = linked().ChannelSubmissions;
    expect(e).toBeTruthy();
    for (const c of ['ID', 'kind', 'status', 'proposed', 'rationale',
                     'submitterId', 'reviewerId', 'reviewNote',
                     'targetChannel_ID', 'createdAt', 'modifiedAt']) {
      expect(e.elements[c]).toBeTruthy();
    }
  });

  test('kind enum is ADD/EDIT/REMOVE, status enum PENDING/APPROVED/REJECTED default PENDING', () => {
    const e = linked().ChannelSubmissions;
    expect(Object.keys(e.elements.kind.enum)).toEqual(['ADD', 'EDIT', 'REMOVE']);
    expect(Object.keys(e.elements.status.enum)).toEqual(['PENDING', 'APPROVED', 'REJECTED']);
    expect(e.elements.status.default.val).toBe('PENDING');
  });

  test('targetChannel associates to Channels and is nullable', () => {
    const e = linked().ChannelSubmissions;
    expect(e.elements.targetChannel.target).toBe(`${NS}.Channels`);
    expect(e.elements.targetChannel.notNull).not.toBe(true);
  });
});
