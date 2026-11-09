import cds from '@sap/cds';

const { expect, GET } = cds.test(__dirname + '/../../..');

describe('DevAdvocates OData collection is reachable and filterable (#advocates-odata-shadow)', () => {
  beforeAll(async () => {
    const db = await cds.connect.to('db');
    const { Advocates } = cds.entities('com.sap.developers.ims');
    await db.run(
      INSERT.into(Advocates).entries(
        { ID: cds.utils.uuid(), slug: 'devadv-emea', firstName: 'A', lastName: 'X', region: 'EMEA' },
        { ID: cds.utils.uuid(), slug: 'devadv-amer', firstName: 'B', lastName: 'Y', region: 'AMER' },
      ),
    );
  });

  it('GET /api/DevAdvocates returns OData shape and honors $filter', async () => {
    const { data } = await GET(`/api/DevAdvocates?$filter=region eq 'EMEA'`);
    expect(data).to.have.property('@odata.context');
    expect(data.value).to.be.an('array');
    expect(data.value.every((r) => r.region === 'EMEA')).to.be.true;
    expect(data.value.some((r) => r.slug === 'devadv-emea')).to.be.true;
    expect(data.value.some((r) => r.region === 'AMER')).to.be.false;
  });

  it('GET /api/DevAdvocates honors $select and $top', async () => {
    const { data } = await GET(`/api/DevAdvocates?$select=slug,region&$top=1`);
    expect(data.value.length).to.equal(1);
    expect(data.value[0]).to.have.property('slug');
  });
});
