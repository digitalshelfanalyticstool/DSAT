import { config } from '../config';

export interface AdaptiveDelayConfig {
  minDelayMs: number;
  maxDelayMs: number;
  backoffBase: number;
  cooldownThreshold: number;
}

const DEFAULT_MAX_DELAY_MS = 10_000;
const DEFAULT_BACKOFF_BASE = 2_000;
const DEFAULT_COOLDOWN_THRESHOLD = 10;

export function createDefaultConfig(overrides?: Partial<AdaptiveDelayConfig>): AdaptiveDelayConfig {
  return {
    minDelayMs: overrides?.minDelayMs ?? config.scraping.retailerApiMinDelayMs,
    maxDelayMs: overrides?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
    backoffBase: overrides?.backoffBase ?? DEFAULT_BACKOFF_BASE,
    cooldownThreshold: overrides?.cooldownThreshold ?? DEFAULT_COOLDOWN_THRESHOLD,
  };
}

export class AdaptiveDelay {
  private currentDelay: number;
  private consecutiveSuccesses: number = 0;
  private consecutiveRateLimits: number = 0;

  constructor(private readonly config: AdaptiveDelayConfig) {
    this.currentDelay = config.minDelayMs;
  }

  /** Current delay in ms, so hot-path callers can skip `wait()` when it is 0. */
  get currentMs(): number {
    return this.currentDelay;
  }

  /**
   * Call after a successful request.
   * Increments the consecutive success counter.
   * After cooldownThreshold consecutive successes, halves the delay (min: minDelayMs).
   * Resets the rate limit counter.
   */
  recordSuccess(): void {
    this.consecutiveRateLimits = 0;
    this.consecutiveSuccesses++;

    if (this.consecutiveSuccesses >= this.config.cooldownThreshold) {
      this.currentDelay = Math.max(this.config.minDelayMs, Math.floor(this.currentDelay / 2));
      this.consecutiveSuccesses = 0;
    }
  }

  /**
   * Call after a 429 or 5xx response.
   * Sets delay to min(maxDelayMs, backoffBase × 2^(consecutiveRateLimits - 1)).
   * Resets the success counter.
   */
  recordRateLimit(): void {
    this.consecutiveSuccesses = 0;
    this.consecutiveRateLimits++;

    this.currentDelay = Math.min(
      this.config.maxDelayMs,
      this.config.backoffBase * Math.pow(2, this.consecutiveRateLimits - 1),
    );
  }

  /** Returns the current delay in ms. */
  getDelay(): number {
    return this.currentDelay;
  }

  /** Wait for the current delay. */
  async wait(): Promise<void> {
    const delay = this.currentDelay;
    if (delay <= 0) return;
    return new Promise((resolve) => setTimeout(resolve, delay));
  }
}
