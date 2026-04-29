export function formatTimeSpent(seconds) {
  if (seconds == null) return '';
  seconds = Number(seconds);
  if (seconds === 0) return '0 min';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  const parts = [];
  if (hours === 1) parts.push('1 hr');
  else if (hours > 1) parts.push(`${hours} hrs`);
  if (minutes > 0) parts.push(`${minutes} min`);
  return parts.join(', ');
}

export function formatTaskRecordsCSV(records) {
  const header = 'DATE & TIME,TYPE,TITLE,TIME SPENT';
  if (records.length === 0) return header;

  const rows = records.map(r => {
    const date = r.completionDate ? formatDate(r.completionDate) : '';
    const type = r.taskType || '';
    const title = escapeCSV(r.titleSnapshot || '');
    const time = formatTimeSpent(r.completionTime);
    return `${date},${type},${title},${time}`;
  });

  return [header, ...rows].join('\n');
}

export function formatAwardMissionsCSV(awards) {
  const header = 'USER,MISSION,COMPLETED AT';
  if (awards.length === 0) return header;

  const rows = awards.map(a => {
    const date = a.completionDate ? formatDate(a.completionDate) : '';
    return `${escapeCSV(a.userDisplayName || '')},${escapeCSV(a.missionTitle || '')},${date}`;
  });

  return [header, ...rows].join('\n');
}

function formatDate(isoString) {
  const d = new Date(isoString);
  const day = d.getUTCDate().toString().padStart(2, '0');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const month = months[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  const time = d.toISOString().slice(11, 19);
  return `${day} ${month} ${year} ${time}`;
}

function escapeCSV(value) {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
