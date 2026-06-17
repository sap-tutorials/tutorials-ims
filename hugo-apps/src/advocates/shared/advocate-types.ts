export type Region = 'AMERICAS' | 'EMEA' | 'APJ';

export interface AdvocateLink {
  kind: 'LinkedIn' | 'X' | 'Mastodon' | 'BlueSky' | 'GitHub' | 'YouTube' | 'Blog' | 'SapCommunity' | 'Email' | 'Other';
  url: string;
  label?: string | null;
  sortOrder?: number;
}

export interface AdvocateTopic {
  slug: string;
  label: string;
}

export interface Advocate {
  ID: string;
  slug: string;
  firstName: string;
  lastName: string;
  title?: string | null;
  pronouns?: string | null;
  location?: string | null;
  region: Region;
  bio?: string | null;
  joinedDate?: string | null;
  hasPhoto: boolean;
  photoUpdatedAt?: string | null;
  topics: AdvocateTopic[];
  links: AdvocateLink[];
}

export interface AdvocatesResponse {
  advocates: Advocate[];
}

export interface AdvocateFilterState {
  region: Region | 'ALL';
  topic: string | 'ALL';   // tag slug
  q: string;               // free-text search
}
