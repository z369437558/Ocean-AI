/** Sending a long response to a client that may stop reading. */
import { Readable, pipeline } from 'node:stream';

/**
 * Writes the chunks of an async iterable to `destination` (an HTTP response, or any Writable) and
 * ends it. Back-pressure decides the pace: the next chunk is only asked for once the destination
 * has room for it, so nothing but a chunk or two is ever buffered.
 *
 * A destination that stops taking data must not keep the source open for ever. Whenever a chunk
 * is ready and the destination has no room for it within `idleTimeoutMs`, the transfer is given
 * up; the same applies to the tail that is still buffered after the last chunk. Only waiting for
 * the destination counts - the time the source needs to produce a chunk does not. `idleTimeoutMs`
 * 0 waits as long as it takes.
 *
 * `abandon` cuts the destination off when the transfer is given up or the source fails. The
 * default destroys it; a caller that knows more can do better (the export route resets the
 * connection, so that a client can never take half a file for a whole one).
 *
 * `signal` (optional) ends the transfer early, as if the destination had closed.
 *
 * Resolves when the transfer is over, however it ended - it never rejects:
 *   { completed: true }                                everything was handed over
 *   { completed: false, stalled: true,  error }        given up after `idleTimeoutMs`
 *   { completed: false, stalled: false, error }        the source failed (`error` is what it threw),
 *                                                      or the destination closed early (error.code
 *                                                      ERR_STREAM_PREMATURE_CLOSE)
 */
export function sendChunks(chunks, destination, { idleTimeoutMs = 0, signal, abandon = () => destination.destroy() } = {}) {
  return new Promise((resolve) => {
    let idleTimer = null;
    let stalled = false;
    let over = false;

    // At most once, and only while there is still something to cut off: a destination that has
    // closed by itself needs no help (the stream machinery reports that as an error as well).
    let cut = false;
    const cutOff = () => {
      if (cut || destination.destroyed) return;
      cut = true;
      abandon();
    };

    const startIdleTimer = () => {
      if (over || idleTimeoutMs <= 0) return;
      idleTimer = setTimeout(() => {
        stalled = true;
        cutOff();
      }, idleTimeoutMs);
    };

    // The error that ended the transfer as it shows here, on the source's side: the source's own
    // failure, or the one the stream machinery passes in when the destination is gone. For the
    // first the machinery's own report cannot be relied on: the destination is cut off the moment
    // the source fails, and whether the transfer then ends with the cause or with the cut
    // ("premature close") differs between Node.js versions.
    let failure = null;

    const body = Readable.from(
      (async function* paced() {
        try {
          for await (const chunk of chunks) {
            startIdleTimer();
            yield chunk; // resumes when the stream asks for more, i.e. the destination made room
            clearTimeout(idleTimer);
          }
        } catch (err) {
          failure = err;
          cutOff(); // before the stream machinery closes the destination in its own, quieter way
          throw err;
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
      resolve(error ? { completed: false, stalled, error: failure ?? error } : { completed: true });
    });
    if (signal?.aborted) stop();
  });
}
