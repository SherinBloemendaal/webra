// Token bucket for per-connection message rate limiting (pure, testable).

import { RATE_BURST, RATE_PER_SECOND } from '@webra/protocol';

export class TokenBucket {
  /**
   * @param {number} [rate] tokens added per second
   * @param {number} [burst] bucket capacity
   * @param {number} [now] milliseconds
   */
  constructor(rate = RATE_PER_SECOND, burst = RATE_BURST, now = Date.now()) {
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
    this.last = now;
    /** Messages refused since the bucket was created. */
    this.refused = 0;
  }

  /** Take one token (or `amount`); false when the caller is over the limit. */
  take(now = Date.now(), amount = 1) {
    const elapsed = Math.max(0, now - this.last);
    this.last = now;
    this.tokens = Math.min(this.burst, this.tokens + (elapsed * this.rate) / 1000);
    if (this.tokens >= amount) {
      this.tokens -= amount;
      return true;
    }
    this.refused++;
    return false;
  }
}
