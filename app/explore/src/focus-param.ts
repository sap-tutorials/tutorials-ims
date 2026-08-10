export function parseFocusParam(search: string): string {
  const v = new URLSearchParams(search).get('focus') || '';
  return /^[a-z0-9][a-z0-9-]{0,80}$/.test(v) ? v : '';
}
