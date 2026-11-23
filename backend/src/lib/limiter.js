/**
 * Lets at most `limit` holders in at a time; everyone else waits their turn in arrival order.
 *
 *   const release = await limiter.acquire({ signal });
 *   try { ... } finally { release(); }
 *
 * acquire() rejects with a LimiterFullError when `maxWaiting` callers are queueing already, and
 * with the signal's reason when the caller gives up while waiting (it then leaves the queue).
 * Calling release() more than once is harmless.
 */
export class LimiterFullError extends Error {
  constructor() {
    super('Too many callers are waiting already');
    this.name = 'LimiterFullError';
  }
}

export function createLimiter(limit, { maxWaiting = Infinity } = {}) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer');
  let active = 0;
  const waiting = [];

  function newRelease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
      admitWaiting();
    };
  }

  function admitWaiting() {
    while (active < limit && waiting.length > 0) {
      active += 1;
      waiting.shift().admit(newRelease());
    }
  }

  return {
    get active() {
      return active;
    },
    get waiting() {
      return waiting.length;
    },

    acquire({ signal } = {}) {
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (active < limit) {
        active += 1;
        return Promise.resolve(newRelease());
      }
      if (waiting.length >= maxWaiting) return Promise.reject(new LimiterFullError());

      return new Promise((resolve, reject) => {
        const entry = {
          admit(release) {
            signal?.removeEventListener('abort', onAbort);
            resolve(release);
          },
        };
        function onAbort() {
          const position = waiting.indexOf(entry);
          if (position === -1) return; // admitted already: nothing to withdraw
          waiting.splice(position, 1);
          reject(signal.reason);
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        waiting.push(entry);
      });
    },
  };
}
