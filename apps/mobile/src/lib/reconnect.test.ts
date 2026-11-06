import { describe, it, expect } from 'vitest';
import { RECONNECT_FIRST_DELAY_MS, RECONNECT_MAX_DELAY_MS, reconnectDelay } from './reconnect';

describe('reconnect pacing', () => {
  it('retries quickly the first time, then backs off', () => {
    const mid = () => 0.5; // no jitter
    const delays = [0, 1, 2, 3, 4, 5, 6, 7].map(n => reconnectDelay(n, mid));
    expect(delays[0]).toBe(RECONNECT_FIRST_DELAY_MS);
    for (let i = 1; i < delays.length; i++) expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
    expect(delays[1]).toBe(2000);
  });

  it('never exceeds the cap (plus jitter), however many attempts', () => {
    for (const n of [10, 50, 10_000]) {
      const d = reconnectDelay(n, () => 0.999);
      expect(d).toBeLessThanOrEqual(RECONNECT_MAX_DELAY_MS * 1.2 + 1);
      expect(d).toBeGreaterThanOrEqual(RECONNECT_MAX_DELAY_MS * 0.8 - 1);
    }
  });

  it('spreads retries so PCs that dropped together do not retry together', () => {
    expect(reconnectDelay(3, () => 1)).toBeGreaterThan(reconnectDelay(3, () => 0));
    const seen = new Set(Array.from({ length: 50 }, () => reconnectDelay(3)));
    expect(seen.size).toBeGreaterThan(10);
  });

  it('is safe for odd input', () => {
    expect(reconnectDelay(-5, () => 0.5)).toBe(RECONNECT_FIRST_DELAY_MS);
    expect(reconnectDelay(1.9, () => 0.5)).toBe(reconnectDelay(1, () => 0.5));
  });
});
