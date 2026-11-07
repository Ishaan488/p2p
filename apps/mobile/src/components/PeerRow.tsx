import React from 'react';
import { ChevronDown, Laptop, Loader2, QrCode, Trash2, Unplug } from 'lucide-react';
import type { PeerView } from '../lib/peerManager';
import { canConnect, needsRepair, peerSubtitle, statusLabel, statusTone } from '../lib/peerPresentation';
import { IconTile, Switch } from './ui';

export { Switch };

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
  isFocused?: boolean;
  onSetFocused?: () => void;
}

export const PeerRow: React.FC<PeerRowProps> = ({
  peer, variant, expanded, onToggleExpand, onToggleTarget, onConnect, onDisconnect, onRemove, onToggleAutoAccept,
  onPairAgain, switchDisabled, isFocused, onSetFocused,
}) => {
  const tone = statusTone(peer.status);
  const busy = peer.status === 'connecting' || peer.status === 'reconnecting';
  const detailsId = `peer-details-${peer.id}`;

  let action: React.ReactNode = null;
  if (peer.status === 'connected') {
    action = variant === 'sheet' ? (
      <Switch checked={!peer.excluded} label={`Send to ${peer.name}`} onChange={sel => onToggleTarget?.(sel)} disabled={switchDisabled} />
    ) : (
      <span className="t-support">Connected</span>
    );
  } else if (busy) {
    action = <Loader2 size={18} className="spin" style={{ color: 'var(--text-2)' }} aria-label={statusLabel(peer.status)} />;
  } else if (needsRepair(peer)) {
    action = <button type="button" className="btn btn-primary btn-sm" onClick={onPairAgain}><QrCode size={14} /> Pair</button>;
  } else if (canConnect(peer)) {
    action = <button type="button" className="btn btn-primary btn-sm" onClick={onConnect}>Connect</button>;
  }

  return (
    <li className="peer-item">
      <div className="row peer-row">
        <button type="button" className="peer-row-info" onClick={onToggleExpand} aria-expanded={expanded} aria-controls={detailsId}>
          <IconTile><Laptop size={18} /></IconTile>
          <span className="row-main">
            <span className="row-title truncate" title={peer.name}>{peer.serverName || peer.name}</span>
            <span className="row-sub truncate">
              <span className={`dot ${tone === 'ok' ? 'ok' : tone === 'busy' ? 'busy' : tone === 'warn' ? 'bad' : ''}`} style={{ display: 'inline-block', marginRight: 6, verticalAlign: 'middle' }} />
              {isFocused && peer.status === 'connected' ? 'Active · ' : ''}{peerSubtitle(peer)}
            </span>
          </span>
          <ChevronDown size={16} className="row-chevron" style={{ transform: expanded ? 'rotate(180deg)' : undefined, transition: 'transform var(--t-fast) var(--ease)' }} aria-hidden="true" />
        </button>
        <div className="peer-action">{action}</div>
      </div>

      {expanded && (
        <div className="peer-details" id={detailsId}>
          {peer.error && peer.status !== 'connected' && <p className="peer-error" role="status">{peer.error}</p>}
          <div className="peer-detail-row">
            <span className="row-title" style={{ fontSize: 14 }}>Accept files automatically</span>
            <Switch checked={peer.autoAccept} label={`Accept files from ${peer.name} automatically`} onChange={onToggleAutoAccept} />
          </div>
          <div className="peer-detail-actions">
            {!isFocused && onSetFocused && peer.status === 'connected' && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={onSetFocused}>Make active</button>
            )}
            {(peer.status === 'connected' || busy) && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={onDisconnect}><Unplug size={14} /> Disconnect</button>
            )}
            <button type="button" className="btn btn-danger-quiet btn-sm" onClick={onRemove}><Trash2 size={14} /> Remove</button>
          </div>
        </div>
      )}
    </li>
  );
};
