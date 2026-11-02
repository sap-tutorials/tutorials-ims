let _ready = false;

export function markSchedulerReady() {
  _ready = true;
}

export function isSchedulerReady() {
  return _ready;
}

export function _resetForTests() {
  _ready = false;
}

export function computeReadiness({ schedulerArmed, dbOk }) {
  const ready = schedulerArmed && dbOk;
  return {
    ready,
    status: ready ? 'ready' : 'not-ready',
    scheduler: schedulerArmed ? 'armed' : 'pending',
    db: dbOk ? 'connected' : 'error',
  };
}
