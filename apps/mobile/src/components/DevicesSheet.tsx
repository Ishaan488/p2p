import React, { useEffect, useState } from 'react';
import { Laptop, Loader2, Plus, Send, Wifi } from './icons';
import { deviceKey, type DiscoveredDevice } from '../lib/discovery';
import { MAX_CONNECTED_PEERS } from '../lib/peers';
import type { PeerView } from '../lib/peerManager';
import { PeerRow } from './PeerRow';
import { Sheet } from './Sheet';
import { IconTile } from './ui';

export interface DevicesSheetProps {
  isOpen: boolean;
  /** 'manage': header switcher. 'pick': choosing who receives something the user is about to send. */
  mode: 'manage' | 'pick';
  /** What is being sent, for the pick title, e.g. "3 files". */
  pickSubject?: string;
  peers: PeerView[];
  focusedId?: string;
  /** PCs found on the Wi-Fi that are not paired yet. */
  nearby: DiscoveredDevice[];
  onClose: () => void;
  onToggleTarget: (id: string, selected: boolean) => void;
  onConnect: (id: string) => void;
  onDisconnect: (id: string) => void;
  onRemove: (id: string) => void;
  onToggleAutoAccept: (id: string, value: boolean) => void;
  onConnectNearby: (device: DiscoveredDevice) => void;
  onAddDevice: () => void;
  /** Pick mode: the user confirmed; send to the PCs currently switched on. */
  onConfirmPick?: () => void;
  onSetFocused?: (id: string) => void;
}

const MAX_NEARBY_SHOWN = 6;

export const DevicesSheet: React.FC<DevicesSheetProps> = ({
  isOpen, mode, pickSubject, peers, focusedId, nearby, onClose, onToggleTarget, onConnect, onDisconnect, onRemove,
  onToggleAutoAccept, onConnectNearby, onAddDevice, onConfirmPick, onSetFocused,
}) => {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  useEffect(() => { if (isOpen) setExpandedId(null); }, [isOpen]);

  const connected = peers.filter(p => p.status === 'connected');
  const targets = connected.filter(p => !p.excluded);
  const picking = mode === 'pick';
  const atLimit = connected.length >= MAX_CONNECTED_PEERS;
  const shownNearby = nearby.slice(0, MAX_NEARBY_SHOWN);

  const description = picking
    ? 'Choose which connected devices receive it.'
    : connected.length > 1
      ? 'Anything you send goes to every device that is switched on.'
      : 'Connect more devices to send to several at once.';

  const footer = picking ? (
    <button type="button" className="btn btn-primary btn-block" onClick={onConfirmPick} disabled={targets.length === 0}>
      <Send size={16} />
      {targets.length === 0
        ? 'Switch on a device'
        : targets.length === 1 ? `Send to ${targets[0].name}` : `Send to ${targets.length} devices`}
    </button>
  ) : (
    <button type="button" className="btn btn-secondary btn-block" onClick={onAddDevice}>
      <Plus size={16} /> Add another device
    </button>
  );

  return (
    <Sheet
      open={isOpen}
      onClose={onClose}
      title={picking ? `Send ${pickSubject || 'this'} to…` : 'Devices'}
      description={description}
      footer={footer}
      flush
    >
      {peers.length > 0 && (
        <ul className="peer-list" aria-label="Your devices">
          {peers.map(peer => (
            <PeerRow
              key={peer.id}
              peer={peer}
              variant="sheet"
              isFocused={peer.id === focusedId}
              onSetFocused={() => onSetFocused?.(peer.id)}
              expanded={expandedId === peer.id}
              onToggleExpand={() => setExpandedId(id => (id === peer.id ? null : peer.id))}
              onToggleTarget={sel => onToggleTarget(peer.id, sel)}
              onConnect={() => onConnect(peer.id)}
              onDisconnect={() => onDisconnect(peer.id)}
              onRemove={() => onRemove(peer.id)}
              onToggleAutoAccept={v => onToggleAutoAccept(peer.id, v)}
              onPairAgain={onAddDevice}
            />
          ))}
        </ul>
      )}

      {atLimit && (
        <p className="sheet-note" role="status">
          {MAX_CONNECTED_PEERS} devices are connected, the most at once. Disconnect one to connect another.
        </p>
      )}

      {!picking && shownNearby.length > 0 && (
        <section aria-label="Nearby devices">
          <div className="section-label"><Wifi size={11} style={{ display: 'inline', marginRight: 6, verticalAlign: '-1px' }} />Nearby</div>
          <ul className="peer-list">
            {shownNearby.map(d => (
              <li key={deviceKey(d)} className="peer-item">
                <div className="row">
                  <IconTile><Laptop size={18} /></IconTile>
                  <span className="row-main">
                    <span className="row-title truncate">{d.serverName || d.name}</span>
                    <span className="row-sub truncate">{d.host}:{d.port}</span>
                  </span>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => onConnectNearby(d)}
                    disabled={d.state === 'appearing'}
                    aria-busy={d.state === 'appearing'}
                  >
                    {d.state === 'appearing' ? <Loader2 size={13} className="spin" /> : null}
                    {d.state === 'appearing' ? 'Checking…' : 'Add'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {nearby.length > shownNearby.length && (
            <p className="sheet-note">+{nearby.length - shownNearby.length} more nearby. Scan a QR code to add a specific one.</p>
          )}
        </section>
      )}
    </Sheet>
  );
};
