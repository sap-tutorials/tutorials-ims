const cds = require('@sap/cds');
async function main() {
  const db = await cds.connect.to('db');
  const csn = await cds.load('*');
  cds.model = cds.compile.for.nodejs(csn);
  const { Users } = cds.entities('com.sap.developers.ims');
  const sample = await db.run(SELECT.from(Users).columns('uuid','sapId','firstName','lastName','email').limit(5));
  console.log(JSON.stringify(sample, null, 2));
  const autoByEmail = (await db.run(SELECT.one.from(Users).columns('count(*) as c').where({email: {like: 'autotest%'}}))).c;
  const autoByUuid = (await db.run(SELECT.one.from(Users).columns('count(*) as c').where({uuid: {like: 'autotest%'}}))).c;
  const autoByFirst = (await db.run(SELECT.one.from(Users).columns('count(*) as c').where({firstName: {like: 'autotest%'}}))).c;
  console.log('autotest by email:', autoByEmail, 'by uuid:', autoByUuid, 'by firstName:', autoByFirst);
}
main().catch(e => { console.error(e.message); process.exit(1); });
