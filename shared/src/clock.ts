/**
 * NTP-lite clock synchronisation (Cristian's algorithm with sample filtering).
 *
 * One exchange:
 *   client: c0 = local time at send
 *   server: s  = server time at receive/reply
 *   client: c3 = local time at receive
 *
 *   rtt    = c3 - c0
 *   offset = s - (c0 + c3) / 2        (serverTime ≈ localTime + offset)
 *
 * The estimate is exact only if the up/down delays are symmetric; the worst
 * case error is bounded by rtt/2. So we keep the last N samples, trust the
 * lowest-RTT one (queueing delay only ever *adds* RTT, never removes it) and
 * take the median offset of samples whose RTT is close to that minimum.
 */
export interface ClockSample {
  offset: number;
  rtt: number;
}

export class ClockSync {
  private samples: ClockSample[] = [];
  private _offset = 0;
  private _rtt = Infinity;

  constructor(private readonly maxSamples = 12) {}

  addSample(c0: number, s: number, c3: number): void {
    const rtt = c3 - c0;
    if (!Number.isFinite(rtt) || rtt < 0 || !Number.isFinite(s)) return;
    const offset = s - (c0 + c3) / 2;
    this.samples.push({ offset, rtt });
    if (this.samples.length > this.maxSamples) this.samples.shift();
    this.recompute();
  }

  private recompute(): void {
    let minRtt = Infinity;
    for (const x of this.samples) if (x.rtt < minRtt) minRtt = x.rtt;
    const near = this.samples.filter((x) => x.rtt <= minRtt * 1.5 + 2);
    const offsets = near.map((x) => x.offset).sort((a, b) => a - b);
    const mid = Math.floor(offsets.length / 2);
    this._offset = offsets.length % 2 ? offsets[mid]! : (offsets[mid - 1]! + offsets[mid]!) / 2;
    this._rtt = minRtt;
  }

  /** serverTime ≈ localTime + offset */
  get offset(): number {
    return this._offset;
  }

  /** Lowest round trip seen in the window (ms). */
  get rtt(): number {
    return this._rtt;
  }

  get count(): number {
    return this.samples.length;
  }

  /** Worst-case error of the current estimate (ms). */
  get uncertainty(): number {
    return Number.isFinite(this._rtt) ? this._rtt / 2 : Infinity;
  }

  /** Enough samples to trust the estimate. */
  get synced(): boolean {
    return this.samples.length >= 3;
  }

  serverNow(localNow: number): number {
    return localNow + this._offset;
  }
}
