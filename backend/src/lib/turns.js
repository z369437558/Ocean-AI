/**
 * Taking turns on the event loop.
 *
 * SQLite calls are synchronous: while one runs, nothing else in the process does. A long job is
 * therefore cut into small steps, and this queue hands the steps out: a job waits for `next()`
 * before every step, and exactly one waiting step is let through per event-loop iteration.
 * Whatever else is pending - requests coming in, responses going out, timers - gets its chance
 * between any two steps, however many jobs are running.
 *
 * (Each job yielding with its own setImmediate() would not do: Node runs all immediates that are
 * due in one go, so N jobs would run N steps back to back before anything else is served.)
 */
export function createTurnQueue() {
  const waiting = [];
  let scheduled = false;

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setImmediate(letOneThrough);
  }

  function letOneThrough() {
    scheduled = false;
    const resume = waiting.shift();
    // An immediate scheduled from inside an immediate runs in the NEXT event-loop iteration, so
    // the step after this one cannot start before the loop has looked at everything else.
    if (waiting.length > 0) schedule();
    resume();
  }

  return {
    /** Resolves when it is the caller's turn: first come, first served, one caller per iteration. */
    next() {
      return new Promise((resolve) => {
        waiting.push(resolve);
        schedule();
      });
    },
    /** Steps currently waiting for their turn. */
    get waiting() {
      return waiting.length;
    },
  };
}
