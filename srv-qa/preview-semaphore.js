// srv-qa/preview-semaphore.js
export function createSemaphore(maxConcurrent) {
  let inFlight = 0;
  const waiters = [];

  function tryGrant() {
    while (inFlight < maxConcurrent && waiters.length > 0) {
      const next = waiters.shift();
      clearTimeout(next.timer);
      inFlight++;
      next.resolve({ release: doRelease });
    }
  }

  function doRelease() {
    inFlight = Math.max(0, inFlight - 1);
    tryGrant();
  }

  function acquire(timeoutMs) {
    return new Promise((resolve, reject) => {
      if (inFlight < maxConcurrent) {
        inFlight++;
        resolve({ release: doRelease });
        return;
      }
      const waiter = { resolve, reject };
      waiter.timer = setTimeout(() => {
        const idx = waiters.indexOf(waiter);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error('Preview semaphore timeout'));
      }, timeoutMs);
      waiters.push(waiter);
    });
  }

  return { acquire, _inspect: () => ({ inFlight, queued: waiters.length }) };
}
