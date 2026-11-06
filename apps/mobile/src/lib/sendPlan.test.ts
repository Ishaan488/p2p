import { describe, it, expect } from 'vitest';
import { SHARE_SETTLE_DELAY_MS, SHARE_SETTLE_MAX_ATTEMPTS, messageIdForPeer, peerTag, shareRoute, shareSettleDelay, summarizeSend, transferIdForPeer } from './sendPlan';

describe('ids per recipient', () => {
  it('gives the same file a different transfer id for each PC', () => {
    const base = 'up-phone-1a2b-xyz';
    expect(transferIdForPeer(base, 'srv-aaaa1111')).not.toBe(transferIdForPeer(base, 'srv-bbbb2222'));
    expect(transferIdForPeer(base, 'srv-aaaa1111')).toBe(transferIdForPeer(base, 'srv-aaaa1111')); // stable, so a transfer can resume
  });

  it('namespaces incoming message ids by PC so two PCs cannot collide', () => {
    expect(messageIdForPeer('aaaa1111', 'msg-1')).not.toBe(messageIdForPeer('bbbb2222', 'msg-1'));
  });

  it('builds a safe tag from any id', () => {
    expect(peerTag('a/b:c d!')).toMatch(/^[a-z0-9]+$/i);
    expect(peerTag('')).toBe('peer');
    expect(peerTag('x'.repeat(100)).length).toBe(8);
  });
});

describe('what the user is told after sending', () => {
  it('says who got it', () => {
    expect(summarizeSend('Sent', ['Office'], [])).toEqual({ text: 'Sent to Office', type: 'success' });
    expect(summarizeSend('Sending', ['Office', 'Laptop'], []).text).toBe('Sending to Office and Laptop');
  });

  it('is clear when some recipients are offline', () => {
    const s = summarizeSend('Sent', ['Office'], ['Laptop']);
    expect(s.text).toBe('Sent to Office. Laptop will get it when back online.');
    expect(s.type).toBe('info');
  });

  it('is clear when nobody is reachable or nobody is picked', () => {
    expect(summarizeSend('Sent', [], ['Laptop']).type).toBe('warning');
    expect(summarizeSend('Sent', [], ['A', 'B']).text).toContain('A and B are offline');
    expect(summarizeSend('Sent', [], [])).toEqual({ text: 'Pick a device to send to', type: 'warning' });
  });
});

describe('where something shared from another app goes', () => {
  it('waits when nothing is connected', () => {
    expect(shareRoute(0, 0)).toBe('wait');
  });
  it('goes straight away only for exactly one connected, switched-on device', () => {
    expect(shareRoute(1, 1)).toBe('send');
  });
  it('asks whenever there is a choice, or when the only device is switched off', () => {
    expect(shareRoute(1, 0)).toBe('ask');
    expect(shareRoute(2, 2)).toBe('ask');
    expect(shareRoute(2, 1)).toBe('ask'); // even with one switched off: confirm
    expect(shareRoute(5, 5)).toBe('ask');
  });
  it('treats a nonsensical count as nothing connected', () => {
    expect(shareRoute(-1, 3)).toBe('wait');
  });
});

describe('a share that arrives while devices are still connecting after a restart', () => {
  it('decides at once when nothing is still connecting', () => {
    expect(shareSettleDelay(['connected', 'idle', 'offline'], 0)).toBeNull();
  });
  it('waits while another device is still coming up, so it cannot go to whichever connected first', () => {
    expect(shareSettleDelay(['connected', 'connecting'], 0)).toBe(SHARE_SETTLE_DELAY_MS);
    expect(shareSettleDelay(['connected', 'reconnecting'], 2)).toBe(SHARE_SETTLE_DELAY_MS);
  });
  it('gives up waiting after a bounded number of tries (a device that never answers must not block the share)', () => {
    expect(shareSettleDelay(['connected', 'connecting'], SHARE_SETTLE_MAX_ATTEMPTS)).toBeNull();
    expect(SHARE_SETTLE_DELAY_MS * SHARE_SETTLE_MAX_ATTEMPTS).toBeLessThanOrEqual(8000);
  });
});
