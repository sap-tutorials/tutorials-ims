const cds = require('@sap/cds');
(async () => {
  const db = await cds.connect.to('db');
  const targets = [
    ['Users', 'COM_SAP_DEVELOPERS_IMS_USERS'],
    ['TaskRecords (completions)', 'COM_SAP_DEVELOPERS_IMS_TASKRECORDS'],
    ['Missions', 'COM_SAP_DEVELOPERS_IMS_MISSIONS'],
    ['CompletionPaths (groups)', 'COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS'],
    ['CompletionPathItems', 'COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHITEMS'],
    ['Tutorials', 'COM_SAP_DEVELOPERS_IMS_TUTORIALS'],
    ['Events', 'COM_SAP_DEVELOPERS_IMS_EVENTS'],
    ['Tags', 'COM_SAP_DEVELOPERS_IMS_TAGS'],
    ['PrimaryAccounts', 'COM_SAP_DEVELOPERS_IMS_PRIMARYACCOUNTS'],
    ['SecondaryAccounts', 'COM_SAP_DEVELOPERS_IMS_SECONDARYACCOUNTS'],
    ['AccomplishmentRecords', 'COM_SAP_DEVELOPERS_IMS_ACCOMPLISHMENTRECORDS'],
    ['Accomplishments', 'COM_SAP_DEVELOPERS_IMS_ACCOMPLISHMENTS'],
    ['TutorialMeta', 'COM_SAP_DEVELOPERS_IMS_TUTORIALMETA'],
    ['ContentFiles', 'COM_SAP_DEVELOPERS_IMS_CONTENTFILES'],
    ['ContentManifest', 'COM_SAP_DEVELOPERS_IMS_CONTENTMANIFEST'],
    ['RepoCatalog', 'COM_SAP_DEVELOPERS_IMS_REPOCATALOG'],
    ['Steps', 'COM_SAP_DEVELOPERS_IMS_STEPS'],
    ['PrizeRecords', 'COM_SAP_DEVELOPERS_IMS_PRIZERECORDS'],
    ['ChangeLog (audit)', 'SAP_CHANGELOG_CHANGELOG'],
  ];
  console.log('Schema:', (await db.run(`SELECT CURRENT_SCHEMA AS S FROM DUMMY`))[0].S);
  console.log('---');
  for (const [label, t] of targets) {
    try {
      const [row] = await db.run(`SELECT COUNT(*) AS C FROM "${t}"`);
      console.log(label.padEnd(28) + String(row.C).padStart(12));
    } catch (e) {
      console.log(label.padEnd(28) + 'ERR ' + (e.message || '').slice(0,60));
    }
  }
  console.log('---');
  // Sample of recent TaskRecords (completions) to see what's there
  try {
    const [{C: total}] = await db.run(`SELECT COUNT(*) AS C FROM "COM_SAP_DEVELOPERS_IMS_TASKRECORDS"`);
    console.log('TaskRecords total:', total);
    if (total > 0) {
      const recent = await db.run(`SELECT TOP 5 ID, USER_ID, TUTORIAL_ID, COMPLETED_AT FROM "COM_SAP_DEVELOPERS_IMS_TASKRECORDS" ORDER BY COMPLETED_AT DESC NULLS LAST`);
      console.log('Recent TaskRecords:', JSON.stringify(recent, null, 2));
    }
  } catch (e) {
    console.log('TaskRecords sample failed:', e.message);
  }
  // Sample Missions
  try {
    const recent = await db.run(`SELECT TOP 5 ID, NAME, SLUG FROM "COM_SAP_DEVELOPERS_IMS_MISSIONS"`);
    console.log('Sample Missions:', JSON.stringify(recent, null, 2));
  } catch (e) {
    console.log('Missions sample failed:', e.message);
  }
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
