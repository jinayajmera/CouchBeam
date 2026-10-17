/**
 * Drift correction policy. Pure and side-effect free so it is unit-testable
 * and reusable by the benchmark's virtual players.
 *
 * `driftSec = localPosition - expectedPosition`
 *    > 0  -> this client is AHEAD  -> slow down
 *    < 0  -> this client is BEHIND -> speed up
 *
 *  |drift| > 500 ms          hard seek      (rate back to 1.0)
 *  engage <= |drift| <= 500  rate nudge     (1.05 behind / 0.95 ahead)
 *  |drift| < release         stop nudging   (hysteresis, prevents rate flapping)
 *
 * A 5 % rate change closes 50 ms of drift per second of playback and is
 * inaudible/invisible for typical content, so a 500 ms gap heals in ~10 s
 * without a visible jump.
 */
export const DRIFT = {
  hardSeekSec: 0.5,
  engageSec: 0.12,
  releaseSec: 0.04,
  fastRate: 1.05,
  slowRate: 0.95,
  /** While paused there is no rate to nudge, so snap if we are visibly off. */
  pausedSnapSec: 0.08,
  /** Added to hard-seek targets to cover the seek's own latency. */
  seekLeadSec: 0.12,
} as const;

export type Correction =
  | { action: 'none'; rate: 1 }
  | { action: 'rate'; rate: number }
  | { action: 'seek'; rate: 1 };

export function computeCorrection(driftSec: number, playing: boolean, currentRate: number): Correction {
  const d = driftSec;
  const abs = Math.abs(d);

  if (!playing) {
    return abs > DRIFT.pausedSnapSec ? { action: 'seek', rate: 1 } : { action: 'none', rate: 1 };
  }

  if (abs > DRIFT.hardSeekSec) return { action: 'seek', rate: 1 };

  // Already correcting: keep going until we cross back inside the release band.
  if (currentRate > 1) {
    return d < -DRIFT.releaseSec ? { action: 'rate', rate: DRIFT.fastRate } : { action: 'none', rate: 1 };
  }
  if (currentRate < 1) {
    return d > DRIFT.releaseSec ? { action: 'rate', rate: DRIFT.slowRate } : { action: 'none', rate: 1 };
  }

  if (abs >= DRIFT.engageSec) {
    return { action: 'rate', rate: d > 0 ? DRIFT.slowRate : DRIFT.fastRate };
  }
  return { action: 'none', rate: 1 };
}
