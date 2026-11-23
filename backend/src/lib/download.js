/** Sending a long response to a client that may stop reading. */
import { Readable, pipeline } from 'node:stream';

/**
 * Writes the chunks of an async iterable to `destination` (an HTTP response, or any Writable) and
 * ends it. Back-pressure decides the pace: the next chunk is only asked for once the destination
 * has room for it, so nothing but a chunk or two is ever buffered.
 *
 * A destination that stops taking data must not keep the source open for ever. Whenever a chunk
 * is ready and the destination has no room for it within `idleTimeoutMs`, the destination is
 * destroyed; the same applies to the tail that is still buffered after the last chunk. Only
 * waiting for the destination counts - the time the source needs to produce a chunk does not.
 * `idleTimeoutMs` 0 waits as long as it takes.
 *
 * `signal` (optional) ends the transfer early, as if the destination had closed.
 *
 * Resolves when the transfer is over, however it ended - it never rejects:
 *   { completed: true }                                everything was handed over
 *   { completed: false, stalled: true,  error }        given up after `idleTimeoutMs`
 *   { completed: false, stalled: false, error }        the source failed, or the destination closed
 *                                                      early (error.code ERR_STREAM_PREMATURE_CLOSE)
 */
export function sendChunks(chunks, destination, { idleTimeoutMs = 0, signal } = {}) {
  return new Promise((resolve) => {
    let idleTimer = null;
    let stalled = false;
    let over = false;

    const startIdleTimer = () => {
      if (over || idleTimeoutMs <= 0) return;
      idleTimer = setTimeout(() => {
        stalled = true;
        destination.destroy();
      }, idleTimeoutMs);
    };

    const body = Readable.from(
      (async function* paced() {
        for await (const chunk of chunks) {
          startIdleTimer();
          yield chunk; // resumes when the stream asks for more, i.e. the destination made room
          clearTimeout(idleTimer);
        }
        startIdleTimer(); // what is buffered still has to be taken
      })(),
      { objectMode: false },
    );

    const stop = () => body.destroy();
    signal?.addEventListener('abort', stop, { once: true });

    pipeline(body, destination, (error) => {
      over = true;
      clearTimeout(idleTimer);
      signal?.removeEventListener('abort', stop);
      resolve(error ? { completed: false, stalled, error } : { completed: true });
    });
    if (signal?.aborted) stop();
  });
}
