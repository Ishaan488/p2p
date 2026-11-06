import type { PeerStatus } from './peerConnection';
import type { PeerView } from './peerManager';

/** How a PC's state is worded and coloured. Kept out of the components so it is consistent everywhere and testable. */

export type StatusTone = 'ok' | 'busy' | 'off' | 'warn';

export function statusLabel(status: PeerStatus): string {
  switch (status) {
    case 'connected': return 'Connected';
    case 'connecting': return 'Connecting…';
    case 'reconnecting': return 'Reconnecting…';
    case 'offline': return 'Offline';
    case 'unpaired': return 'Needs pairing again';
    case 'idle':
    default: return 'Not connected';
  }
}

export function statusTone(status: PeerStatus): StatusTone {
  switch (status) {
    case 'connected': return 'ok';
    case 'connecting':
    case 'reconnecting': return 'busy';
    case 'unpaired': return 'warn';
    case 'offline':
    case 'idle':
    default: return 'off';
  }
}

/** The older single-PC screens speak in these four words. */
export function toLegacyStatus(status: PeerStatus): 'connected' | 'connecting' | 'error' | 'disconnected' {
  switch (status) {
    case 'connected': return 'connected';
    case 'connecting':
    case 'reconnecting': return 'connecting';
    case 'offline':
    case 'unpaired': return 'error';
    case 'idle':
    default: return 'disconnected';
  }
}

/** Whether a Connect button makes sense for this PC. */
export function canConnect(peer: Pick<PeerView, 'status'>): boolean {
  return peer.status === 'idle' || peer.status === 'offline';
}

/** Whether tapping should try again with the same key (false: needs a fresh pairing). */
export function needsRepair(peer: Pick<PeerView, 'status'>): boolean {
  return peer.status === 'unpaired';
}

/** One calm line under a PC's name; the long error text is kept for the detail view. */
export function peerSubtitle(peer: Pick<PeerView, 'status' | 'address' | 'deviceName'>): string {
  const where = peer.address.replace(/^https?:\/\//, '').split('/')[0];
  const withWhere = (label: string) => (where ? `${label} · ${where}` : label);
  switch (peer.status) {
    case 'connected': return withWhere('Connected');
    case 'connecting': return withWhere('Connecting…');
    case 'reconnecting': return withWhere('Reconnecting…');
    case 'offline': return withWhere('Offline, retrying');
    case 'unpaired': return 'Scan its QR code to pair again';
    case 'idle':
    default: return withWhere('Not connected');
  }
}
