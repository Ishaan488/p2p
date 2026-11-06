import React from 'react';
import { ChevronDown, Laptop, Loader2, QrCode, Trash2, Unplug } from 'lucide-react';
import type { PeerView } from '../lib/peerManager';
import { canConnect, needsRepair, peerSubtitle, statusLabel, statusTone } from '../lib/peerPresentation';

/** A small on/off control with proper switch semantics and a 44px touch target. */
export const Switch: React.FC<{ checked: boolean; label: string; onChange: (next: boolean) => void; disabled?: boolean }> = ({
  checked, label, onChange, disabled
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    className={`p2p-switch ${checked ? 'on' : ''}`}
    onClick={() => onChange(!checked)}
  >
    <span className="p2p-switch-knob" />
  </button>
);

export interface PeerRowProps {
  peer: PeerView;
  /** 'sheet': a "send to" switch on connected PCs. 'standby': a Connect button, no switch. */
  variant: 'sheet' | 'standby';
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleTarget?: (selected: boolean) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onRemove: () => void;
  onToggleAutoAccept: (value: boolean) => void;
  /** The PC no longer knows this phone: open the pairing flow. */
  onPairAgain: () => void;
  /** Disable the switch (e.g. the last recipient in a share that needs one). */
  switchDisabled?: boolean;
}

export const PeerRow: React.FC<PeerRowProps> = ({
  peer, variant, expanded, onToggleExpand, onToggleTarget, onConnect, onDisconnect, onRemove, onToggleAutoAccept, onPairAgain, switchDisabled
}) => {
  const tone = statusTone(peer.status);
  const busy = peer.status === 'connecting' || peer.status === 'reconnecting';
  const detailsId = `peer-details-${peer.id}`;

  let action: React.ReactNode = null;
  if (peer.status === 'connected') {
    action = variant === 'sheet' ? (
      <Switch
        checked={!peer.excluded}
        label={`Send to ${peer.name}`}
        onChange={sel => onToggleTarget?.(sel)}
        disabled={switchDisabled}
      />
    ) : (
      <span className="peer-state-pill ok">Connected</span>
    );
  } else if (busy) {
    action = <Loader2 size={18} className="animate-spin peer-busy-icon" aria-label={statusLabel(peer.status)} />;
  } else if (needsRepair(peer)) {
    action = (
      <button type="button" className="btn btn-primary btn-compact" onClick={onPairAgain}>
        <QrCode size={13} /> Pair
      </button>
    );
  } else if (canConnect(peer)) {
    action = (
      <button type="button" className="btn btn-primary btn-compact" onClick={onConnect}>
        Connect
      </button>
    );
  }

  return (
    <li className={`peer-row tone-${tone} ${expanded ? 'expanded' : ''}`}>
      <div className="peer-row-main">
        <button
          type="button"
          className="peer-row-info"
          onClick={onToggleExpand}
          aria-expanded={expanded}
          aria-controls={detailsId}
        >
          <span className="peer-avatar" aria-hidden="true">
            <Laptop size={18} strokeWidth={1.8} />
            <span className={`peer-status-dot ${tone}`} />
          </span>
          <span className="peer-text">
            <span className="peer-row-name" title={peer.name}>{peer.serverName || peer.name}</span>
            <span className="peer-sub">{peerSubtitle(peer)}</span>
          </span>
          <ChevronDown size={14} className="peer-chevron" aria-hidden="true" />
        </button>
        <div className="peer-action">{action}</div>
      </div>

      {expanded && (
        <div className="peer-details" id={detailsId}>
          {peer.error && peer.status !== 'connected' && <p className="peer-error" role="status">{peer.error}</p>}
          <div className="peer-detail-row">
            <span className="peer-detail-label">Accept files automatically</span>
            <Switch checked={peer.autoAccept} label={`Accept files from ${peer.name} automatically`} onChange={onToggleAutoAccept} />
          </div>
          <div className="peer-detail-actions">
            {(peer.status === 'connected' || busy) && (
              <button type="button" className="peer-text-btn" onClick={onDisconnect}>
                <Unplug size={14} /> Disconnect
              </button>
            )}
            <button type="button" className="peer-text-btn danger" onClick={onRemove}>
              <Trash2 size={14} /> Remove
            </button>
          </div>
        </div>
      )}
    </li>
  );
};
