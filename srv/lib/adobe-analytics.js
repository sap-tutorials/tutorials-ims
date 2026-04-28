import cds from '@sap/cds';

const ADOBE_ENDPOINT = 'https://sap.d1.sc.omtrdc.net/b/ss/{rsid}/6';
const DEFAULT_REPORT_SUITE = 'sapdeveloperdev';

export function buildAdobeBeacon({ visitorId, taskLegacyId, taskType, taskTitle, reportSuiteId }) {
  const rsid = reportSuiteId || DEFAULT_REPORT_SUITE;
  return `<?xml version="1.0" encoding="UTF-8"?>
<request>
  <reportSuiteID>${rsid}</reportSuiteID>
  <visitorID>${visitorId}</visitorID>
  <events>event86</events>
  <eVar1>${taskLegacyId}</eVar1>
  <eVar2>${taskType}</eVar2>
  <eVar3>${escapeXml(taskTitle)}</eVar3>
</request>`;
}

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function sendAdobeBeacon(beaconData) {
  const LOG = cds.log('adobe-analytics');
  const xml = buildAdobeBeacon(beaconData);
  const rsid = beaconData.reportSuiteId || DEFAULT_REPORT_SUITE;
  const url = ADOBE_ENDPOINT.replace('{rsid}', rsid);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body: xml
    });
    if (!response.ok) {
      LOG.warn(`Adobe Analytics responded ${response.status}`);
    }
    return { success: response.ok };
  } catch (err) {
    LOG.error('Adobe Analytics beacon failed:', err.message);
    return { success: false, error: err.message };
  }
}
