import type { AlertSeverity, Ui5Priority } from './types';

export function severityToPriority(severity: AlertSeverity): Ui5Priority {
  switch (severity) {
    case 'Error':   return 'High';
    case 'Warning': return 'Medium';
    case 'Success': return 'Low';
    default:        return 'None';
  }
}
