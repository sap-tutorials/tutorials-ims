export interface Channel {
  name: string; url?: string; purpose?: string; category?: string;
  subcategory?: string; platform?: string; isSapOwned?: boolean;
  tags?: string[]; focusAreas?: string[]; relatedUrls?: string[];
  ownerType?: string; ownerName?: string; status?: string; editorialNote?: string;
}
export interface FilterState {
  query?: string; category?: string; platform?: string;
  focusArea?: string; status?: string;
  ownerScope?: 'all' | 'sap' | 'community';
}
export function filterChannels(channels: Channel[], state: FilterState): Channel[] {
  const q = (state.query || '').trim().toLowerCase();
  return channels.filter((c) => {
    if (state.category && c.category !== state.category) return false;
    if (state.platform && c.platform !== state.platform) return false;
    if (state.status && c.status !== state.status) return false;
    if (state.focusArea && !(c.focusAreas || []).includes(state.focusArea)) return false;
    if (state.ownerScope === 'sap' && !c.isSapOwned) return false;
    if (state.ownerScope === 'community' && c.isSapOwned) return false;
    if (q) {
      const hay = `${c.name} ${c.purpose || ''} ${(c.tags || []).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// Spec §10 labeling — owner_type-derived badge. Falls back to the coarse
// SAP/Community split when ownerType is absent (older ingest rows).
const OWNER_BADGE: Record<string, string> = {
  SAP_Official: 'SAP',
  SAP_Developer_Advocate: 'SAP Advocate',
  SAP_Executive: 'SAP',
  Community_Member: 'Community',
  Community_Organization: 'Community',
  User_Group: 'User Group',
  Third_party_Training: 'Third-party',
  Third_party_Media: 'Third-party',
  Third_party_Platform: 'Third-party',
};
export function ownerBadge(c: Channel): string {
  return OWNER_BADGE[c.ownerType || ''] || (c.isSapOwned ? 'SAP' : 'Community');
}
