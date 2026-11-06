/**
 * Reconnection pacing for one PC. Exponential backoff with jitter, so a PC that is
 * switched off is not hammered, and several PCs that all drop at once (the Wi-Fi
 * blinked) do not retry in lock-step.
 */

export const RECONNECT_FIRST_DELAY_MS = 1_000;
export const RECONNECT_BASE_DELAY_MS = 2_000;
export const RECONNECT_MAX_DELAY_MS = 30_000;
const GROWTH = 1.8;
const JITTER = 0.2; // +/-20%

/** Delay before reconnect attempt number `attempt` (0 = the first retry after a drop). */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const n = Math.max(0, Math.floor(attempt));
  const nominal = n === 0 ? RECONNECT_FIRST_DELAY_MS : Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * GROWTH ** (n - 1));
  const spread = nominal * JITTER;
  return Math.round(nominal - spread + random() * 2 * spread);
}
