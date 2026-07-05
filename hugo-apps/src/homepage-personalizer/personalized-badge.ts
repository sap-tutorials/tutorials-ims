const CLOUD_LABEL: Record<string, string> = {
  btp: 'SAP BTP', aws: 'AWS', azure: 'Microsoft Azure',
  gcp: 'Google Cloud', alibaba: 'Alibaba Cloud',
  oracle: 'Oracle Cloud', ibm: 'IBM Cloud',
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);
}

function profileClause(p: { role: string | null; deployment: string | null; cloud: string | null }): string {
  const parts: string[] = [];
  if (p.role) parts.push(p.role);
  if (p.cloud) parts.push(CLOUD_LABEL[p.cloud] || p.cloud.toUpperCase());
  if (p.deployment) parts.push(p.deployment === 'onprem' ? 'on-premise' : p.deployment);
  return parts.join(', ');
}

export function renderBadge(
  root: HTMLElement | null,
  profile: { role: string | null; deployment: string | null; cloud: string | null } | null,
  mode: 'personalized' | 'default'
): void {
  if (!root) return;
  root.hidden = false;
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');
  root.classList.add('personalized-badge');

  if (mode === 'default') {
    root.innerHTML =
      `<span aria-hidden="true">✨</span> ` +
      `Viewing the default homepage · ` +
      `<a href="#" data-action="reset-personalize">Personalize again</a>`;
    root.querySelector<HTMLAnchorElement>('[data-action="reset-personalize"]')!
      .addEventListener('click', (e) => {
        e.preventDefault();
        try { sessionStorage.removeItem('sap-devs-homepage-default'); } catch { /* ignore */ }
        const url = new URL(location.href);
        url.searchParams.delete('default');
        location.assign(url.toString());
      });
    return;
  }

  const clause = profile ? profileClause(profile) : '';
  const clauseHtml = clause ? ` · ${escapeHtml(clause)} ·` : ' ·';
  root.innerHTML =
    `<span aria-hidden="true">✨</span> ` +
    `Personalized for you${clauseHtml} ` +
    `<a href="/me/#learning-preferences">Adjust</a> · ` +
    `<a href="?default=1">See default</a>`;
}
