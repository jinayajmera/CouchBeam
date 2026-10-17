import { describe, expect, it } from 'vitest';
import { ClockSync } from '../src/clock';

/** Simulate an exchange with a known true offset and asymmetric delays. */
function exchange(clock: ClockSync, trueOffset: number, up: number, down: number, t = 1_000_000) {
  const c0 = t; // local send
  const s = c0 + up + trueOffset; // server stamps when it receives
  const c3 = c0 + up + down; // local receive
  clock.addSample(c0, s, c3);
}

describe('ClockSync (Cristian)', () => {
  it('recovers the offset exactly when delays are symmetric', () => {
    const c = new ClockSync();
    for (let i = 0; i < 5; i++) exchange(c, 3500, 20, 20, 1_000_000 + i * 1000);
    expect(c.offset).toBeCloseTo(3500, 6);
    expect(c.rtt).toBe(40);
  });

  it('error is bounded by rtt/2 under maximal asymmetry', () => {
    const c = new ClockSync();
    exchange(c, -1200, 38, 2); // nearly all delay on the way up
    expect(Math.abs(c.offset - -1200)).toBeLessThanOrEqual(c.uncertainty + 1e-9);
  });

  it('prefers low-RTT samples over congested ones', () => {
    const c = new ClockSync();
    for (let i = 0; i < 4; i++) exchange(c, 500, 5, 5, 1_000_000 + i * 1000);
    exchange(c, 500, 200, 5, 2_000_000); // queueing spike -> badly skewed estimate
    exchange(c, 500, 5, 150, 2_001_000);
    expect(Math.abs(c.offset - 500)).toBeLessThan(1);
  });

  it('ignores impossible samples', () => {
    const c = new ClockSync();
    c.addSample(100, 50, 90); // negative rtt
    c.addSample(100, NaN, 120);
    expect(c.count).toBe(0);
    expect(c.synced).toBe(false);
  });

  it('is synced after 3 samples and converts local->server time', () => {
    const c = new ClockSync();
    for (let i = 0; i < 3; i++) exchange(c, 100, 10, 10, 1_000_000 + i * 1000);
    expect(c.synced).toBe(true);
    expect(c.serverNow(5000)).toBeCloseTo(5100, 6);
  });
});
