import cds from '@sap/cds';

let counters = {};

export async function getNextLegacyId(entity, db) {
  const isHana = cds.env.requires?.db?.kind === 'hana' ||
                 cds.env.requires?.db?.[cds.env.profiles?.find(p => p)]?.kind === 'hana' ||
                 db.constructor?.name?.includes('Hana');
  if (isHana) {
    const sequenceName = `COM_SAP_DEVELOPERS_IMS_${entity.toUpperCase()}_SEQ`;
    const [row] = await db.run(`SELECT "${sequenceName}".NEXTVAL as "nextval" FROM DUMMY`);
    return row.nextval;
  }

  if (!counters[entity]) {
    counters[entity] = 10000000;
  }
  return ++counters[entity];
}

export function resetCounters() {
  counters = {};
}
