// srv/lib/alert-enums.js
//
// Static code-list source of truth for Alerts.severity and Alerts.audience.
// These arrays back the AdminService.AlertSeverities and
// AdminService.AlertAudiences read-only entities — Fiori Elements V4 fetches
// them as the value-help collection so the object-page editor renders a
// Select control instead of a plain text input.
//
// Codes MUST mirror the inline enums on db/schema.cds:467-471 exactly
// (drift would surface as @assert.range rejection on write).
// Labels are display-only — Fiori uses them only in the dropdown items.

export const ALERT_SEVERITIES = Object.freeze([
  Object.freeze({ code: 'Information', label: 'Information' }),
  Object.freeze({ code: 'Success',     label: 'Success'     }),
  Object.freeze({ code: 'Warning',     label: 'Warning'     }),
  Object.freeze({ code: 'Error',       label: 'Error'       }),
]);

export const ALERT_AUDIENCES = Object.freeze([
  Object.freeze({ code: 'ALL',           label: 'All visitors'    }),
  Object.freeze({ code: 'AUTHENTICATED', label: 'Signed-in users' }),
  Object.freeze({ code: 'ADMIN',         label: 'Admins only'     }),
]);

export function listAlertSeverities() {
  return ALERT_SEVERITIES.map((s) => ({ ...s }));
}

export function listAlertAudiences() {
  return ALERT_AUDIENCES.map((a) => ({ ...a }));
}
