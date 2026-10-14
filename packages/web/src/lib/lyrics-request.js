/** @typedef {import('@iroh-fm/client/types').TrackLyrics} TrackLyrics */

/**
 * One track/connection request lifetime. No external lyrics services are called.
 * Retry hints are lower bounds, with conservative minimums and a finite budget.
 * Thrown errors (including older servers) are terminal for this lifetime.
 * @param {{getTrackLyrics: (id: string) => Promise<TrackLyrics>}} client
 * @param {string} trackId
 * @param {(result: TrackLyrics | null, message: string) => void} update
 * @returns {() => void}
 */
export function requestLyrics(client, trackId, update) {
  let active = true;
  let attempts = 0;
  /** @type {TrackLyrics | null} */
  let available = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let retryTimer;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timeoutTimer;

  async function request() {
    if (!active) return;
    attempts += 1;
    try {
      /** @type {Promise<never>} */
      const timeout = new Promise((_, reject) => {
        timeoutTimer = setTimeout(() => reject(new Error("Lyrics request timed out")), 15_000);
      });
      const result = await Promise.race([client.getTrackLyrics(trackId), timeout]);
      clearTimeout(timeoutTimer);
      if (!active) return;
      if (
        !result ||
        result.track_id !== trackId ||
        !["Pending", "Available", "NotFound", "Unavailable", "Instrumental"].includes(result.status)
      )
        throw new Error("Unsupported lyrics response");
      const annotationPending =
        result.status === "Available" &&
        Number(result.retry_after_seconds) > 0;
      if (result.status === "Available") available = result;
      const retryable =
        result.status === "Pending" || result.status === "Unavailable" || annotationPending;
      update(
        result,
        retryable && attempts >= 8 ? "Automatic retries paused. Try again later." : "",
      );
      if (retryable && attempts < 8) {
        const minimum = result.status === "Unavailable" ? 30 : 5;
        const hint = Number(result.retry_after_seconds);
        const seconds = Math.max(minimum, Number.isFinite(hint) && hint > 0 ? hint : minimum);
        // Do not overflow the browser timer and accidentally create a rapid loop.
        if (seconds * 1000 <= 2_147_483_647)
          retryTimer = setTimeout(() => void request(), seconds * 1000);
      }
    } catch {
      clearTimeout(timeoutTimer);
      if (active)
        update(
          available,
          available
            ? "Automatic retries paused. Could not refresh furigana. Try again later."
            : "Lyrics unavailable. The server may not support lyrics, or the connection failed.",
        );
    }
  }

  void request();
  return () => {
    active = false;
    clearTimeout(retryTimer);
    clearTimeout(timeoutTimer);
  };
}
