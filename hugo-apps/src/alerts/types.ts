// hugo-apps/src/alerts/types.ts
export type AlertSeverity = 'Information' | 'Success' | 'Warning' | 'Error';
export type Ui5Priority = 'High' | 'Medium' | 'Low' | 'None';

export interface ApiAlert {
  id: string;
  title: string;
  body: string | null;
  severity: AlertSeverity;
  ctaLabel: string | null;
  ctaUrl: string | null;
  dismissible: boolean;
  startsAt: string;
  endsAt: string | null;
}

export interface ApiAlertsResponse {
  alerts: ApiAlert[];
  fetchedAt: string;
}
