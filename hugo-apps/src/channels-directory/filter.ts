export interface Channel {
  name: string; url?: string; purpose?: string; category?: string;
  platform?: string; isSapOwned?: boolean; tags?: string[]; ownerType?: string;
}
export interface FilterState {
  query?: string; category?: string; platform?: string;
  ownerScope?: 'all' | 'sap' | 'community';
}
export function filterChannels(channels: Channel[], state: FilterState): Channel[] {
  const q = (state.query || '').trim().toLowerCase();
  return channels.filter((c) => {
    if (state.category && c.category !== state.category) return false;
    if (state.platform && c.platform !== state.platform) return false;
    if (state.ownerScope === 'sap' && !c.isSapOwned) return false;
    if (state.ownerScope === 'community' && c.isSapOwned) return false;
    if (q) {
      const hay = `${c.name} ${c.purpose || ''} ${(c.tags || []).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}
