import React, { useState } from 'react';
import type { PeerView } from '../lib/peerManager';
import { deviceKey, type DiscoveredDevice } from '../lib/discovery';
import {
  Laptop, QrCode, Edit3, Loader2, X, HelpCircle, Smartphone, MoreHorizontal, Settings, Unplug, WifiOff,
} from 'lucide-react';
import { Sheet } from './Sheet';
import { IconTile, Notice, StateView } from './ui';

export interface ConnectionScreenProps {
  mode: 'standby' | 'add';
  status: 'connected' | 'disconnected' | 'connecting' | 'error';
  address: string;
  setAddress: (addr: string) => void;
  peers: PeerView[];
  deviceName: string;
  setDeviceName: (name: string) => void;
  connectError: string;
  cameraError: string;
  isScanning: boolean;
  setIsScanning: (scanning: boolean) => void;
  isEditingIp: boolean;
  setIsEditingIp: React.Dispatch<React.SetStateAction<boolean>>;
  discoveredDevices: DiscoveredDevice[];
  discoveryTip: string;
  onConnectPeer: (id: string) => void;
  onDisconnectPeer: (id: string) => void;
  onToggleAutoAccept: (id: string, value: boolean) => void;
  onManualConnect: (e: React.FormEvent) => void;
  onConnectDiscovered: (device: DiscoveredDevice) => void;
  onOpenPreferences: () => void;
  onUnpairPeer: (id: string) => void;
  onStartAddDevice?: () => void;
  pendingApproval?: { host: string; name: string } | null;
  onCancelPairing?: () => void;
  connectingDiscoveredKey?: string | null;
  /** Add mode: leave without connecting anything. */
  onBack?: () => void;
}

const MAX_LISTED_DEVICES = 50;
const hostOf = (a: string) => a.replace(/^https?:\/\//, '').split('/')[0];

/**
 * Device discovery: nearby computers first, saved ones below, and the less common ways to
 * connect (QR, IP address, help) behind one options sheet.
 */
export const ConnectionScreen: React.FC<ConnectionScreenProps> = ({
  mode, status, address, setAddress, peers, deviceName, setDeviceName, connectError, cameraError, isScanning,
  setIsScanning, isEditingIp, setIsEditingIp, discoveredDevices, onConnectPeer, onManualConnect, onConnectDiscovered,
  onOpenPreferences, onUnpairPeer, pendingApproval, onCancelPairing, connectingDiscoveredKey, onBack,
}) => {
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [deviceOpen, setDeviceOpen] = useState(false);

  const pairedAddresses = new Set(peers.map(p => hostOf(p.address)));
  const pairedIds = new Set(peers.map(p => p.id));

  const allAvailable = discoveredDevices
    .filter(d => !(d.id && pairedIds.has(d.id)) && !pairedAddresses.has(`${d.host}:${d.port}`))
    .sort((a, b) =>
      (a.serverName || a.name).localeCompare(b.serverName || b.name, undefined, { sensitivity: 'base' }) ||
      deviceKey(a).localeCompare(deviceKey(b)));
  const available = allAvailable.slice(0, MAX_LISTED_DEVICES);
  const hiddenCount = allAvailable.length - available.length;
  const connecting = status === 'connecting';
  const errText = cameraError || connectError;

  const connectDiscovered = (d: DiscoveredDevice) => {
    setAddress(`${d.host}:${d.port}`);
    onConnectDiscovered(d);
  };

  const closeIp = () => setIsEditingIp(false);

  return (
    <main className="screen discovery">
      {/* QR scanner stays mounted so the camera library keeps a stable node. */}
      <div className="scanner" role="dialog" aria-label="QR code scanner" style={{ display: isScanning ? 'flex' : 'none' }}>
        <div className="scanner-bar">
          <button type="button" className="icon-btn" onClick={() => setIsScanning(false)} aria-label="Close scanner"><X size={22} /></button>
          <span className="scanner-title">Scan QR code</span>
        </div>
        <div className="scanner-stage">
          <div id="qr-reader" className="qr-viewport" />
          <div className="scanner-reticle" />
        </div>
        <p className="scanner-hint">Point the camera at the QR code on your computer</p>
      </div>

      <header className="top-bar">
        {mode === 'add' && onBack ? (
          <button type="button" className="icon-btn" onClick={onBack} aria-label="Back"><X size={22} /></button>
        ) : null}
        <h1 className="top-bar-title">{mode === 'add' ? 'Add device' : 'Nearby devices'}</h1>
        <button type="button" className="icon-btn" onClick={() => setOptionsOpen(true)} aria-label="More ways to connect">
          <MoreHorizontal size={22} />
        </button>
        {mode !== 'add' && (
          <button type="button" className="icon-btn" onClick={onOpenPreferences} aria-label="Settings"><Settings size={20} /></button>
        )}
      </header>

      <div className="scroll">
        {pendingApproval && (
          <div className="notice" role="status" style={{ alignItems: 'center' }}>
            <Loader2 size={18} className="spin notice-icon" style={{ marginTop: 0 }} />
            <div className="notice-main">
              <div className="notice-title">Waiting for {pendingApproval.name}</div>
              <div>Approve this phone on your computer.</div>
            </div>
            {onCancelPairing && <button type="button" className="btn btn-ghost btn-sm" onClick={onCancelPairing}>Cancel</button>}
          </div>
        )}

        {errText && !pendingApproval && (
          <Notice tone="error" title="Couldn't connect" actions={
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOptionsOpen(true)}>Other ways to connect</button>
          }>
            {errText}
          </Notice>
        )}

        <div className="section-head">
          <span className="t-eyebrow">On this Wi‑Fi</span>
          <span className="searching" role="status">
            <Loader2 size={12} className="spin" /> Searching
          </span>
        </div>

        {available.length > 0 ? (
          <ul className="group rows discovery-list">
            {available.map(d => {
              const key = deviceKey(d);
              const isApproving = pendingApproval?.host === `${d.host}:${d.port}`;
              const busy = connectingDiscoveredKey === key || isApproving;
              const name = d.serverName || d.name;
              return (
                <li key={key} className="row">
                  <IconTile><Laptop size={18} /></IconTile>
                  <span className="row-main">
                    <span className="row-title truncate">{name}</span>
                    <span className="row-sub truncate">{d.state === 'appearing' ? 'Checking…' : 'Ready to connect'}</span>
                  </span>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => connectDiscovered(d)}
                    disabled={busy || connecting}
                    aria-label={`Connect to ${name}`}
                  >
                    {busy ? <Loader2 size={14} className="spin" /> : null}
                    {busy ? 'Connecting' : 'Connect'}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : peers.length === 0 ? (
          <StateView
            icon={<WifiOff size={32} strokeWidth={1.5} />}
            title="No computers found"
            body="Open P2P Link on your computer and make sure both devices are on the same Wi‑Fi."
          >
            <button type="button" className="btn btn-primary" onClick={() => setIsScanning(true)}><QrCode size={16} /> Scan QR code</button>
            <button type="button" className="btn btn-secondary" onClick={() => setIsEditingIp(true)}><Edit3 size={16} /> Enter IP address</button>
          </StateView>
        ) : (
          <p className="empty-line">No new computers nearby.</p>
        )}

        {hiddenCount > 0 && <p className="empty-line">+{hiddenCount} more nearby. Scan a QR code to reach a specific one.</p>}

        {peers.length > 0 && (
          <>
            <div className="section-head"><span className="t-eyebrow">Saved devices</span></div>
            <ul className="group rows">
              {peers.map(peer => {
                const online = discoveredDevices.some(
                  d => `${d.host}:${d.port}` === hostOf(peer.address) || (Boolean(d.id) && d.id === peer.id));
                return (
                  <li key={peer.id} className="row">
                    <IconTile><Laptop size={18} /></IconTile>
                    <span className="row-main">
                      <span className="row-title truncate">{peer.serverName || peer.name}</span>
                      <span className="row-sub truncate">
                        <span className={`dot ${online ? 'ok' : ''}`} style={{ display: 'inline-block', marginRight: 6, verticalAlign: 'middle' }} />
                        {online ? 'Available now' : 'Not seen on this Wi‑Fi'}
                      </span>
                    </span>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => onConnectPeer(peer.id)} disabled={connecting} aria-label={`Connect to ${peer.name}`}>
                      {connecting ? 'Connecting' : 'Connect'}
                    </button>
                    <button type="button" className="icon-btn" onClick={() => onUnpairPeer(peer.id)} aria-label={`Forget ${peer.name}`}>
                      <Unplug size={18} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        <p className="foot-note">Encrypted end to end · stays on your network</p>
      </div>

      {/* Connection options */}
      <Sheet open={optionsOpen} onClose={() => setOptionsOpen(false)} title="Connect" description="Other ways to reach your computer" flush>
        <ul className="rows">
          <li><button type="button" className="row" onClick={() => { setOptionsOpen(false); setIsScanning(true); }}>
            <QrCode size={20} className="row-icon" /><span className="row-main"><span className="row-title">Scan QR code</span><span className="row-sub">From the P2P Link window on your computer</span></span>
          </button></li>
          <li><button type="button" className="row" onClick={() => { setOptionsOpen(false); setIsEditingIp(true); }}>
            <Edit3 size={20} className="row-icon" /><span className="row-main"><span className="row-title">Enter IP address</span><span className="row-sub">Type the address shown on your computer</span></span>
          </button></li>
          <li><button type="button" className="row" onClick={() => { setOptionsOpen(false); setDeviceOpen(true); }}>
            <Smartphone size={20} className="row-icon" /><span className="row-main"><span className="row-title">My device</span><span className="row-sub">{deviceName || 'This phone'}</span></span>
          </button></li>
          <li><button type="button" className="row" onClick={() => { setOptionsOpen(false); setHelpOpen(true); }}>
            <HelpCircle size={20} className="row-icon" /><span className="row-main"><span className="row-title">Connection help</span><span className="row-sub">If your computer doesn't show up</span></span>
          </button></li>
        </ul>
      </Sheet>

      {/* Manual IP */}
      <Sheet
        open={isEditingIp}
        onClose={closeIp}
        title="Enter IP address"
        footer={
          <button type="submit" form="manual-ip-form" className="btn btn-primary btn-block" disabled={connecting}>
            {connecting ? 'Connecting…' : 'Connect'}
          </button>
        }
      >
        <form id="manual-ip-form" onSubmit={onManualConnect} className="form-stack">
          <div className="field">
            <label htmlFor="manual-ip-input" className="field-label">Computer address</label>
            <input
              id="manual-ip-input"
              type="text"
              inputMode="url"
              className="input input-mono"
              value={address}
              onChange={e => setAddress(e.target.value)}
              placeholder="192.168.1.15:8080"
              autoCapitalize="none"
              autoCorrect="off"
              required
            />
            <span className="field-hint">Shown on your computer next to “Address”.</span>
          </div>
          <div className="field">
            <label htmlFor="manual-device-name-input" className="field-label">This phone's name</label>
            <input
              id="manual-device-name-input"
              type="text"
              className="input"
              value={deviceName}
              onChange={e => setDeviceName(e.target.value)}
              maxLength={40}
              placeholder="My phone"
            />
          </div>
          {errText && <span className="field-error" role="alert">{errText}</span>}
        </form>
      </Sheet>

      {/* My device */}
      <Sheet open={deviceOpen} onClose={() => setDeviceOpen(false)} title="My device" description="How this phone appears to computers on the network.">
        <div className="group">
          <div className="row"><span className="row-main"><span className="row-title">Name</span></span><span className="row-value">{deviceName || 'This phone'}</span></div>
          <div className="row"><span className="row-main"><span className="row-title">Pairing</span></span><span className="row-value">Approved on your computer</span></div>
        </div>
        <button type="button" className="btn btn-secondary btn-block" style={{ marginTop: 'var(--s-4)' }} onClick={() => { setDeviceOpen(false); onOpenPreferences(); }}>
          Change in Settings
        </button>
      </Sheet>

      {/* Help */}
      <Sheet open={helpOpen} onClose={() => setHelpOpen(false)} title="Connection help">
        <ol className="help-steps">
          <li>Open P2P Link on your computer.</li>
          <li>Connect both devices to the same Wi‑Fi network.</li>
          <li>Turn off VPNs, and check the network allows devices to talk to each other. Guest and office networks often don't.</li>
          <li>Still not listed? Scan the QR code or enter the address shown on your computer.</li>
        </ol>
      </Sheet>
    </main>
  );
};

export default ConnectionScreen;
