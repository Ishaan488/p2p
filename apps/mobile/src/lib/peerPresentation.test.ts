import { describe, it, expect } from 'vitest';
import type { PeerStatus } from './peerConnection';
import { canConnect, needsRepair, peerSubtitle, statusLabel, statusTone, toLegacyStatus } from './peerPresentation';

const all: PeerStatus[] = ['idle', 'connecting', 'reconnecting', 'connected', 'offline', 'unpaired'];

describe('how a PC is described', () => {
  it('has a label, a tone and a legacy status for every state', () => {
    for (const s of all) {
      expect(statusLabel(s).length).toBeGreaterThan(0);
      expect(['ok', 'busy', 'off', 'warn']).toContain(statusTone(s));
      expect(['connected', 'connecting', 'error', 'disconnected']).toContain(toLegacyStatus(s));
    }
  });

  it('colours the states sensibly', () => {
    expect(statusTone('connected')).toBe('ok');
    expect(statusTone('reconnecting')).toBe('busy');
    expect(statusTone('unpaired')).toBe('warn');
    expect(statusTone('offline')).toBe('off');
  });

  it('only offers Connect where it can work, and sends unpaired PCs to pairing', () => {
    expect(all.filter(s => canConnect({ status: s }))).toEqual(['idle', 'offline']);
    expect(needsRepair({ status: 'unpaired' })).toBe(true);
    expect(needsRepair({ status: 'offline' })).toBe(false);
  });

  it('keeps the subtitle short and never shows the URL scheme or path', () => {
    const peer = { status: 'connected' as PeerStatus, address: 'http://192.168.1.10:8080/x', deviceName: 'Phone' };
    expect(peerSubtitle(peer)).toBe('Connected · 192.168.1.10:8080');
    // two PCs with the same name must stay distinguishable in every state
    expect(peerSubtitle({ ...peer, status: 'offline' })).toBe('Offline, retrying · 192.168.1.10:8080');
    expect(peerSubtitle({ ...peer, status: 'reconnecting' })).toBe('Reconnecting… · 192.168.1.10:8080');
    expect(peerSubtitle({ ...peer, status: 'idle', address: '' })).toBe('Not connected');
    expect(peerSubtitle({ ...peer, status: 'unpaired' })).not.toContain('192.168');
  });
});
