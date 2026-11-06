import { describeTargets } from './peers';

/**
 * Helpers for sending one thing to several PCs: ids that stay unique per
 * recipient, and the one-line summary the user reads afterwards.
 */

/** Short, id-safe tag for a PC, used to keep per-PC ids apart. */
export const peerTag = (peerId: string): string => peerId.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'peer';

/**
 * The same file sent to two PCs is two transfers (separate resume state and
 * progress on each PC), so each recipient gets its own transfer id.
 */
export const transferIdForPeer = (baseTransferId: string, peerId: string): string => `${baseTransferId}-${peerTag(peerId)}`;

/** Ids of messages from different PCs could collide; namespace them by PC. */
export const messageIdForPeer = (peerId: string, rawId: string): string => `${peerTag(peerId)}:${rawId}`;

export interface SendSummary {
  text: string;
  type: 'success' | 'info' | 'warning';
}

/**
 * `sent` got it now; `queued` is selected but not connected at this moment
 * and will get it when it reconnects. Names are the display names.
 */
export function summarizeSend(verb: 'Sent' | 'Sending', sent: readonly string[], queued: readonly string[]): SendSummary {
  if (sent.length === 0 && queued.length === 0) {
    return { text: 'Pick a device to send to', type: 'warning' };
  }
  if (sent.length === 0) {
    return {
      text: queued.length === 1
        ? `${queued[0]} is offline. It will get this when it reconnects.`
        : `${describeTargets(queued)} are offline. They will get this when they reconnect.`,
      type: 'warning'
    };
  }
  if (queued.length === 0) return { text: `${verb} to ${describeTargets(sent)}`, type: verb === 'Sent' ? 'success' : 'info' };
  return {
    text: `${verb} to ${describeTargets(sent)}. ${describeTargets(queued)} will get it when back online.`,
    type: 'info'
  };
}

export type ShareRoute =
  /** No device is connected yet: keep it until one connects. */
  | 'wait'
  /** Exactly one device is connected and switched on: just send. */
  | 'send'
  /** Several choices (or none switched on): ask where it should go. */
  | 'ask';

/**
 * What to do with something shared into the app from another app. With a single device it goes
 * straight away; otherwise the user is asked first, because a share must never reach a device by surprise.
 */
export function shareRoute(connectedCount: number, targetCount: number): ShareRoute {
  if (connectedCount <= 0) return 'wait';
  if (connectedCount === 1 && targetCount === 1) return 'send';
  return 'ask';
}

export const SHARE_SETTLE_DELAY_MS = 1500;
export const SHARE_SETTLE_MAX_ATTEMPTS = 4;

/**
 * After a restart several PCs connect one after another. A share that arrived meanwhile must not go to
 * whichever came up first, so while any PC is still connecting it waits (briefly, a bounded number of
 * times) before the decision is made. Returns the delay to wait, or null when it is time to decide.
 */
export function shareSettleDelay(statuses: readonly string[], attempt: number): number | null {
  const stillConnecting = statuses.some(s => s === 'connecting' || s === 'reconnecting');
  if (!stillConnecting || attempt >= SHARE_SETTLE_MAX_ATTEMPTS) return null;
  return SHARE_SETTLE_DELAY_MS;
}
