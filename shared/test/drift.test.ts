import { describe, expect, it } from 'vitest';
import { DRIFT, computeCorrection } from '../src/drift';
import { expectedPosition, type PlaybackState } from '../src/types';

describe('computeCorrection', () => {
  it('does nothing inside the dead band', () => {
    expect(computeCorrection(0.05, true, 1)).toEqual({ action: 'none', rate: 1 });
    expect(computeCorrection(-0.1, true, 1)).toEqual({ action: 'none', rate: 1 });
  });

  it('speeds up when behind and slows down when ahead (minor drift)', () => {
    expect(computeCorrection(-0.3, true, 1)).toEqual({ action: 'rate', rate: 1.05 });
    expect(computeCorrection(0.3, true, 1)).toEqual({ action: 'rate', rate: 0.95 });
  });

  it('hard-seeks beyond 500 ms in either direction', () => {
    expect(computeCorrection(0.51, true, 1).action).toBe('seek');
    expect(computeCorrection(-0.51, true, 1.05).action).toBe('seek');
    expect(computeCorrection(0.5, true, 1).action).toBe('rate'); // boundary is exclusive
  });

  it('uses hysteresis: keeps nudging until inside the release band', () => {
    expect(computeCorrection(-0.08, true, 1.05)).toEqual({ action: 'rate', rate: 1.05 });
    expect(computeCorrection(-0.03, true, 1.05)).toEqual({ action: 'none', rate: 1 });
    expect(computeCorrection(0.08, true, 0.95)).toEqual({ action: 'rate', rate: 0.95 });
    expect(computeCorrection(0.03, true, 0.95)).toEqual({ action: 'none', rate: 1 });
  });

  it('stops nudging as soon as the sign flips (no overshoot ping-pong)', () => {
    expect(computeCorrection(0.02, true, 1.05).action).toBe('none');
  });

  it('snaps while paused only when visibly off', () => {
    expect(computeCorrection(0.05, false, 1).action).toBe('none');
    expect(computeCorrection(0.2, false, 1).action).toBe('seek');
  });

  it('converges: a 450 ms lag heals in about 10 s at +5 % rate', () => {
    let drift = -0.45;
    let rate = 1;
    let t = 0;
    while (t < 30) {
      const c = computeCorrection(drift, true, rate);
      rate = c.rate;
      drift += (rate - 1) * 0.1; // 100 ms control tick
      t += 0.1;
      if (Math.abs(drift) < DRIFT.releaseSec) break;
    }
    expect(t).toBeGreaterThan(5);
    expect(t).toBeLessThan(11);
  });
});

describe('expectedPosition', () => {
  const base: PlaybackState = { seq: 1, mediaId: 'x', status: 'playing', pos: 10, anchor: 1000, hold: false, by: null };
  it('advances with server time while playing', () => {
    expect(expectedPosition(base, 3500)).toBeCloseTo(12.5, 6);
  });
  it('waits for a scheduled (future) anchor', () => {
    expect(expectedPosition(base, 400)).toBe(10);
  });
  it('is frozen while paused', () => {
    expect(expectedPosition({ ...base, status: 'paused' }, 99_999)).toBe(10);
  });
});
