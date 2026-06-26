// srv/lib/audit-event.js
//
// Extracted from srv/admin-service.js so any CAP service can emit
// SecurityEvent audit records without re-rolling the closure (#617).
//
// Usage:
//   const audit = createAuditEmitter(await cds.connect.to('audit-log'), LOG);
//   await audit('TutorialRebuildTriggered', { user, slug, source });
//
// The audit-log binding is optional — in dev/mock-auth environments it may be
// missing. We swallow that case so handlers never block on telemetry. Per-event
// throws are also caught and warned, NOT propagated — a successful business
// mutation must not become a 500 just because audit logging hiccuped.

export function createAuditEmitter(binding, logger) {
  return async function emitAudit(action, data) {
    if (!binding) return;
    try {
      await binding.log('SecurityEvent', { data: { action, ...data } });
    } catch (err) {
      logger?.warn?.(
        `audit-event: emit failed for ${action} (${err?.message ?? err})`
      );
    }
  };
}
