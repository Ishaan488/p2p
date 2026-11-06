import React, { useEffect, useRef, useState } from 'react';
import { Laptop, Loader2, Plus, Send, Wifi, X } from 'lucide-react';
import { backButtonManager } from '../lib/backButton';
import { deviceKey, type DiscoveredDevice } from '../lib/discovery';
import { MAX_CONNECTED_PEERS } from '../lib/peers';
import type { PeerView } from '../lib/peerManager';
import { PeerRow } from './PeerRow';

export interface DevicesSheetProps {
  isOpen: boolean;
  /** 'manage': header switcher. 'pick': choosing who receives something the user is about to send. */
  mode: 'manage' | 'pick';
  /** What is being sent, for the pick title, e.g. "3 files". */
  pickSubject?: string;
  peers: PeerView[];
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
}

const MAX_NEARBY_SHOWN = 6;

export const DevicesSheet: React.FC<DevicesSheetProps> = ({
  isOpen, mode, pickSubject, peers, nearby, onClose, onToggleTarget, onConnect, onDisconnect, onRemove,
  onToggleAutoAccept, onConnectNearby, onAddDevice, onConfirmPick
}) => {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState(0);
  const touchStartY = useRef<number | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  // The parent passes a new onClose on every render. Depending on it would re-run the effect below each
  // time, collapsing the expanded row and re-registering the back button on every unrelated update.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (touchStartY.current === null) return;
    const deltaY = e.touches[0].clientY - touchStartY.current;
    if (deltaY > 0) {
      setDragOffset(deltaY);
    }
  };

  const handleTouchEnd = () => {
    if (dragOffset > 75) {
      onCloseRef.current();
    }
    touchStartY.current = null;
    setDragOffset(0);
  };

  useEffect(() => {
    if (!isOpen) return;
    const prevFocus = document.activeElement as HTMLElement | null;
    setExpandedId(null);
    const unregister = backButtonManager.push(() => {
      onCloseRef.current();
      return true;
    });
    const onKey = (e: KeyboardEvent) => {
      // Keep Tab inside the dialog: it is modal.
      if (e.key === 'Tab' && sheetRef.current) {
        const items = [...sheetRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), select, input, [href], [tabindex]:not([tabindex="-1"])')]
          .filter(el => el.offsetParent !== null);
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !sheetRef.current.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !sheetRef.current.contains(active))) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    const focusTimer = setTimeout(() => closeRef.current?.focus(), 120);
    return () => {
      unregister();
      window.removeEventListener('keydown', onKey);
      clearTimeout(focusTimer);
      prevFocus?.focus?.();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const connected = peers.filter(p => p.status === 'connected');
  const targets = connected.filter(p => !p.excluded);
  const picking = mode === 'pick';
  const atLimit = connected.length >= MAX_CONNECTED_PEERS;
  const shownNearby = nearby.slice(0, MAX_NEARBY_SHOWN);

  return (
    <div className="sheet-backdrop p2p-devices-backdrop" role="presentation" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={sheetRef}
        className="sheet-container p2p-devices-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="devices-sheet-title"
        style={{
          transform: dragOffset > 0 ? `translateY(${dragOffset}px)` : undefined,
          transition: dragOffset > 0 ? 'none' : 'transform 200ms cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        <div
          className="sheet-drag-handle"
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={handleTouchEnd}
        />

        <div
          className="sheet-header"
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={handleTouchEnd}
        >
          <div className="p2p-devices-heading">
            <h2 id="devices-sheet-title" className="p2p-devices-title">
              {picking ? `Send ${pickSubject || 'this'} to…` : 'Devices'}
            </h2>
            <p className="p2p-devices-hint">
              {picking
                ? 'Choose which connected devices receive it.'
                : connected.length > 1
                  ? 'Anything you send goes to every device that is switched on.'
                  : 'Connect more devices to send to several at once.'}
            </p>
          </div>
          <button ref={closeRef} type="button" className="header-action-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="p2p-devices-scroll">
          {peers.length > 0 && (
            <section aria-label="Your devices">
              <ul className="peer-list">
                {peers.map(peer => (
                  <PeerRow
                    key={peer.id}
                    peer={peer}
                    variant="sheet"
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
            </section>
          )}

          {atLimit && (
            <p className="p2p-devices-note" role="status">
              {MAX_CONNECTED_PEERS} devices are connected, the most at once. Disconnect one to connect another.
            </p>
          )}

          {!picking && shownNearby.length > 0 && (
            <section aria-label="Nearby devices" className="p2p-nearby">
              <h3 className="p2p-devices-section-title"><Wifi size={12} /> Nearby</h3>
              <ul className="peer-list">
                {shownNearby.map(d => (
                  <li key={deviceKey(d)} className="peer-row nearby">
                    <div className="peer-row-main">
                      <div className="peer-row-info static">
                        <span className="peer-avatar" aria-hidden="true">
                          <Laptop size={18} strokeWidth={1.8} />
                        </span>
                        <span className="peer-text">
                          <span className="peer-name">{d.serverName || d.name}</span>
                          <span className="peer-sub">{d.host}:{d.port}</span>
                        </span>
                      </div>
                      <div className="peer-action">
                        <button
                          type="button"
                          className="btn btn-secondary btn-compact"
                          onClick={() => onConnectNearby(d)}
                          disabled={d.state === 'appearing'}
                          aria-busy={d.state === 'appearing'}
                        >
                          {d.state === 'appearing' ? <Loader2 size={12} className="animate-spin" /> : null}
                          {d.state === 'appearing' ? 'Checking…' : 'Add'}
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
              {nearby.length > shownNearby.length && (
                <p className="p2p-devices-note">+{nearby.length - shownNearby.length} more nearby. Scan a QR code to add a specific one.</p>
              )}
            </section>
          )}
        </div>

        {picking ? (
          <button
            type="button"
            className="btn btn-primary full-width p2p-devices-primary"
            onClick={onConfirmPick}
            disabled={targets.length === 0}
          >
            <Send size={15} />
            {targets.length === 0
              ? 'Switch on a device'
              : targets.length === 1
                ? `Send to ${targets[0].name}`
                : `Send to ${targets.length} devices`}
          </button>
        ) : (
          <button type="button" className="btn btn-secondary full-width p2p-devices-add" onClick={onAddDevice}>
            <Plus size={15} /> Add another device
          </button>
        )}
      </div>
    </div>
  );
};
