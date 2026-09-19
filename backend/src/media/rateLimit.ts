/** Per-key token bucket: `capacity` tokens refill linearly over `windowMs`. */

/**
 * Upper bound on tracked keys. A bucket that has refilled to capacity carries no state worth keeping, so a sweep
 * drops those first; if every bucket is still throttled the oldest are evicted. Without this an attacker who varies
 * the key (a spoofed forwarded-for, say) would grow the map until the process runs out of memory.
 */
const MAX_KEYS = 10_000;

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(
    private readonly capacity: number,
    private readonly windowMs: number,
  ) {}

  /** Consume one token. Returns false when the bucket is empty. */
  take(key: string, now = Date.now()): boolean {
    const rate = this.windowMs <= 0 ? this.capacity : this.capacity / this.windowMs;
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= MAX_KEYS) this.evict(now, rate);
      b = { tokens: this.capacity, updatedAt: now };
      this.buckets.set(key, b);
    } else {
      const elapsed = Math.max(0, now - b.updatedAt);
      b.tokens = Math.min(this.capacity, b.tokens + elapsed * rate);
      b.updatedAt = now;
    }
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** Drop fully refilled buckets; fall back to the least recently seen when none have refilled. */
  private evict(now: number, rate: number): void {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [k, v] of this.buckets) {
      if (Math.min(this.capacity, v.tokens + Math.max(0, now - v.updatedAt) * rate) >= this.capacity) {
        this.buckets.delete(k);
        continue;
      }
      if (v.updatedAt < oldestAt) {
        oldestAt = v.updatedAt;
        oldestKey = k;
      }
    }
    if (this.buckets.size >= MAX_KEYS && oldestKey !== null) this.buckets.delete(oldestKey);
  }
}
