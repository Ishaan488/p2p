import React from 'react';
import type { Pairing } from '../lib/api';
import type { DiscoveredDevice } from '../lib/discovery';
import { BrandLogo } from './BrandLogo';
import {
  Laptop,
  QrCode,
  Edit3,
  Sliders,
  Unlink,
  Lock,
  Wifi,
  AlertCircle,
  Loader2,
  ArrowRight
} from 'lucide-react';

export interface ConnectionScreenProps {
  status: 'connected' | 'disconnected' | 'connecting' | 'error';
  address: string;
  setAddress: (addr: string) => void;
  pairing: Pairing | null;
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
  onQuickConnect: () => void;
  onManualConnect: (e: React.FormEvent) => void;
  onPairAndConnect: (host: string, code?: string, scheme?: 'http' | 'https', cert?: string) => void;
  onOpenPreferences: () => void;
  onUnpairPrompt: () => void;
}

/**
 * ConnectionScreen Component
 *
 * Standby and pairing experience for P2P Link mobile app.
 * Follows the Obsidian + Soft Lavender design language with a balanced vertical layout,
 * reduced card footprint, prominent semantic status, inline IP configuration,
 * and 1-tap connection for Wi-Fi discovered devices.
 */
export const ConnectionScreen: React.FC<ConnectionScreenProps> = ({
  status,
  address,
  setAddress,
  pairing,
  deviceName,
  setDeviceName,
  connectError,
  cameraError,
  isScanning,
  setIsScanning,
  isEditingIp,
  setIsEditingIp,
  discoveredDevices,
  discoveryTip,
  onQuickConnect,
  onManualConnect,
  onPairAndConnect,
  onOpenPreferences,
  onUnpairPrompt
}) => {
  // Discovered devices on LAN that aren't already represented by the active pairing address
  const availableDevices = discoveredDevices.filter(
    d => !pairing || `${d.host}:${d.port}` !== address
  );

  const handleConnectDiscovered = (d: DiscoveredDevice) => {
    const targetHost = `${d.host}:${d.port}`;
    setAddress(targetHost);
    try {
      localStorage.setItem('p2p_address', targetHost);
    } catch {}
    onPairAndConnect(targetHost, undefined, d.scheme, d.cert);
  };

  const getStatusLabel = () => {
    switch (status) {
      case 'connecting':
        return 'Connecting';
      case 'error':
        return 'Offline';
      case 'connected':
        return 'Connected';
      case 'disconnected':
      default:
        return 'Standby';
    }
  };

  return (
    <main className="connection-page connection-screen">
      <style>{`
        /* Scoped Connection Screen Refinements (Obsidian + Soft Lavender) */
        .connection-screen {
          flex: 1;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          align-items: center;
          padding: 1.25rem 1rem calc(1.25rem + env(safe-area-inset-bottom));
          overflow-y: auto;
          overflow-x: hidden;
          background-color: var(--bg-app);
          width: 100%;
          box-sizing: border-box;
        }

        .connection-stage-compact {
          width: 100%;
          max-width: 400px;
          margin: auto 0;
          display: flex;
          flex-direction: column;
          gap: 0.9rem;
          animation: stageEnter 300ms var(--ease-spring);
          box-sizing: border-box;
        }

        /* 20-30% Reduced Device Card Footprint */
        .continuity-card-compact {
          width: 100%;
          background: var(--surface);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-lg);
          padding: 1.35rem 1.15rem 1.15rem;
          display: flex;
          flex-direction: column;
          align-items: center;
          text-align: center;
          box-shadow: var(--shadow-sm);
          transition: border-color var(--transition-normal);
          box-sizing: border-box;
        }

        .continuity-ring-compact {
          position: relative;
          margin-bottom: 0.75rem;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .continuity-ring-compact::before {
          content: '';
          position: absolute;
          width: 60px;
          height: 60px;
          border-radius: 50%;
          border: 1px solid var(--border-subtle);
          pointer-events: none;
        }

        .continuity-icon-compact {
          width: 48px;
          height: 48px;
          border-radius: 50%;
          background: var(--surface-secondary);
          border: 1px solid var(--border-strong);
          color: var(--text-primary);
          display: flex;
          align-items: center;
          justify-content: center;
          transition: transform var(--transition-normal);
        }

        .continuity-icon-compact.pulsing {
          animation: radarPulse 1.6s infinite ease-in-out;
        }

        .continuity-status-dot-badge {
          position: absolute;
          bottom: 1px;
          right: 1px;
          width: 12px;
          height: 12px;
          border-radius: 50%;
          background: var(--accent);
          border: 2px solid var(--surface);
          box-sizing: border-box;
        }

        .continuity-status-dot-badge.connecting {
          background: var(--warning);
        }

        .continuity-status-dot-badge.error {
          background: var(--error);
        }

        .continuity-status-dot-badge.connected {
          background: var(--success);
        }

        /* Device Name: 20px, 600 weight */
        .device-name-primary {
          font: var(--text-device-name);
          font-size: 1.25rem;
          font-weight: 600;
          line-height: 1.25;
          color: var(--text-primary);
          letter-spacing: -0.02em;
          margin: 0 0 0.35rem 0;
          max-width: 100%;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        /* Prominent Semantic Status Pill */
        .device-status-pill {
          display: inline-flex;
          align-items: center;
          gap: 0.35rem;
          padding: 0.2rem 0.65rem;
          border-radius: var(--radius-full);
          font-size: 0.72rem;
          font-weight: 600;
          letter-spacing: 0.02em;
          margin-bottom: 0.45rem;
        }

        .device-status-pill.connecting {
          background: var(--warning-subtle);
          border: 1px solid var(--warning-border);
          color: var(--warning);
        }

        .device-status-pill.error {
          background: var(--error-subtle);
          border: 1px solid var(--error-border);
          color: var(--error);
        }

        .device-status-pill.disconnected {
          background: var(--accent-subtle);
          border: 1px solid var(--accent-border);
          color: var(--accent);
        }

        .device-status-pill.connected {
          background: var(--success-subtle);
          border: 1px solid var(--success-border);
          color: var(--success);
        }

        .status-indicator-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: currentColor;
          flex-shrink: 0;
        }

        .status-indicator-dot.pulse {
          animation: statusBlink 1.4s infinite ease-in-out;
        }

        @keyframes statusBlink {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.35; transform: scale(0.85); }
        }

        .device-meta-row {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 0.4rem;
          font-size: 0.76rem;
          color: var(--text-secondary);
          margin-bottom: 1.05rem;
          max-width: 100%;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .device-meta-row .meta-dot {
          opacity: 0.5;
        }

        /* Primary Connect Button with Loading / Pulse */
        .connect-btn-primary {
          width: 100%;
          height: 44px;
          border-radius: var(--radius-md);
          font-weight: 600;
          font-size: 0.88rem;
          margin-bottom: 0.75rem;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 0.45rem;
          transition: all var(--transition-fast);
        }

        .connect-btn-primary.connecting {
          animation: radarPulse 1.6s infinite ease-in-out;
        }

        /* Secondary Actions Strip */
        .secondary-actions-strip {
          display: flex;
          align-items: center;
          justify-content: center;
          flex-wrap: wrap;
          gap: 0.35rem;
          width: 100%;
        }

        .action-pill-btn {
          display: inline-flex;
          align-items: center;
          gap: 0.35rem;
          padding: 0.38rem 0.65rem;
          border-radius: var(--radius-full);
          background: var(--surface-secondary);
          border: 1px solid var(--border-subtle);
          color: var(--text-secondary);
          font-size: 0.74rem;
          font-weight: 500;
          cursor: pointer;
          transition: all var(--transition-fast);
          white-space: nowrap;
        }

        .action-pill-btn:hover,
        .action-pill-btn:focus-visible {
          background: var(--surface-elevated);
          border-color: var(--border-strong);
          color: var(--text-primary);
        }

        .action-pill-btn.active {
          background: var(--accent-subtle);
          border-color: var(--accent-border);
          color: var(--accent);
        }

        .action-pill-btn.danger:hover,
        .action-pill-btn.danger:focus-visible {
          background: var(--error-subtle);
          border-color: var(--error-border);
          color: var(--error);
        }

        /* Inline IP Smooth Transitions */
        .inline-ip-wrapper {
          width: 100%;
          overflow: hidden;
          animation: inlineExpand 220ms var(--ease-spring);
          margin-top: 0.75rem;
          padding-top: 0.75rem;
          border-top: 1px solid var(--border-subtle);
        }

        @keyframes inlineExpand {
          from {
            opacity: 0;
            transform: translateY(-5px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .inline-ip-form {
          display: flex;
          gap: 0.45rem;
          width: 100%;
        }

        /* Discovered LAN Section Prominently in Viewport */
        .discovered-banner-section {
          width: 100%;
          display: flex;
          flex-direction: column;
          gap: 0.45rem;
          animation: stageEnter 280ms var(--ease-spring);
        }

        .discovered-header-bar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 0.2rem;
        }

        .discovered-label-text {
          display: flex;
          align-items: center;
          gap: 0.35rem;
          font-size: 0.66rem;
          font-weight: 700;
          letter-spacing: 0.08em;
          color: var(--accent);
          text-transform: uppercase;
        }

        .discovered-badge-count {
          font-size: 0.65rem;
          font-weight: 600;
          padding: 0.1rem 0.45rem;
          border-radius: var(--radius-full);
          background: var(--accent-subtle);
          color: var(--accent);
          border: 1px solid var(--accent-border);
        }

        .discovered-item-card {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 0.65rem 0.85rem;
          background: var(--surface);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-md);
          gap: 0.6rem;
          transition: all var(--transition-fast);
          box-shadow: var(--shadow-sm);
        }

        .discovered-item-card:hover {
          border-color: var(--accent-border);
          background: var(--surface-secondary);
        }

        .discovered-item-info {
          display: flex;
          align-items: center;
          gap: 0.6rem;
          min-width: 0;
        }

        .discovered-item-icon {
          width: 32px;
          height: 32px;
          border-radius: var(--radius-sm);
          background: var(--surface-secondary);
          border: 1px solid var(--border-subtle);
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--accent);
          flex-shrink: 0;
        }

        .discovered-item-details {
          display: flex;
          flex-direction: column;
          min-width: 0;
          gap: 0.1rem;
        }

        .discovered-item-name {
          font-size: 0.84rem;
          font-weight: 600;
          color: var(--text-primary);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .discovered-item-addr {
          font-size: 0.72rem;
          color: var(--text-secondary);
          font-family: var(--font-mono);
          font-variant-numeric: tabular-nums;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .connection-alert-box {
          display: flex;
          align-items: flex-start;
          gap: 0.45rem;
          width: 100%;
          padding: 0.65rem 0.8rem;
          border-radius: var(--radius-sm);
          font-size: 0.76rem;
          line-height: 1.4;
          text-align: left;
          margin-bottom: 0.75rem;
          box-sizing: border-box;
        }

        .connection-alert-box.error {
          background: var(--error-subtle);
          border: 1px solid var(--error-border);
          color: var(--error);
        }

        .connection-alert-box .alert-icon {
          flex-shrink: 0;
          margin-top: 1px;
        }
      `}</style>

      <div className="connection-stage-compact">
        {/* QR Scanner Card Mode */}
        {isScanning ? (
          <div className="scanner-card">
            <div className="scanner-header">
              <h2 className="scanner-title">Scan QR Code</h2>
              <p className="scanner-subtitle">
                Point your camera at the QR code on your computer
              </p>
            </div>

            {/* Preserves exact #qr-reader DOM element for html5-qrcode */}
            <div id="qr-reader" className="qr-viewport" />

            {cameraError && (
              <div className="connection-alert-box error" role="alert">
                <AlertCircle size={14} className="alert-icon" />
                <span>{cameraError}</span>
              </div>
            )}

            <button
              type="button"
              onClick={() => setIsScanning(false)}
              className="btn btn-secondary full-width"
            >
              Cancel
            </button>
          </div>
        ) : (
          <>
            {/* Discovered LAN Devices Section (Prominently placed above or before manual steps) */}
            {availableDevices.length > 0 && (
              <section className="discovered-banner-section" aria-label="Available on local Wi-Fi">
                <div className="discovered-header-bar">
                  <div className="discovered-label-text">
                    <Wifi size={13} />
                    <span>Available on Wi-Fi</span>
                  </div>
                  <span className="discovered-badge-count">{availableDevices.length}</span>
                </div>

                <div className="discovered-list">
                  {availableDevices.map(d => (
                    <div key={`${d.host}:${d.port}`} className="discovered-item-card">
                      <div className="discovered-item-info">
                        <div className="discovered-item-icon">
                          <Laptop size={16} strokeWidth={1.8} />
                        </div>
                        <div className="discovered-item-details">
                          <span className="discovered-item-name">{d.serverName || d.name}</span>
                          <span className="discovered-item-addr">{d.host}:{d.port}</span>
                        </div>
                      </div>
                      <button
                        type="button"
                        className="btn btn-primary btn-compact"
                        onClick={() => handleConnectDiscovered(d)}
                        title={`Connect to ${d.serverName || d.name}`}
                      >
                        Connect
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Main Continuity Card (Paired or Unpaired) */}
            {pairing ? (
              <div className="continuity-card-compact">
                {/* Compact Concentric Ring & Avatar */}
                <div className="continuity-ring-compact">
                  <div className={`continuity-icon-compact ${status === 'connecting' ? 'pulsing' : ''}`}>
                    <Laptop size={22} strokeWidth={1.8} />
                  </div>
                  <span className={`continuity-status-dot-badge ${status}`} />
                </div>

                {/* Primary Device Name (20px, 600 weight) */}
                <h2 className="device-name-primary" title={pairing.serverName || 'Desktop PC'}>
                  {pairing.serverName || 'Desktop PC'}
                </h2>

                {/* Prominent Semantic Status Pill */}
                <div className={`device-status-pill ${status}`}>
                  <span className={`status-indicator-dot ${status === 'connecting' ? 'pulse' : ''}`} />
                  <span>{getStatusLabel()}</span>
                </div>

                {/* Secondary Meta Row */}
                <div className="device-meta-row">
                  <span className="mono-text">{address || 'Local Wi-Fi'}</span>
                  <span className="meta-dot">·</span>
                  <span>{pairing.deviceName || 'Mobile Device'}</span>
                </div>

                {/* Alerts / Connection Errors */}
                {(cameraError || connectError) && (
                  <div className="connection-alert-box error" role="alert">
                    <AlertCircle size={14} className="alert-icon" />
                    <span>{cameraError || connectError}</span>
                  </div>
                )}

                {/* Primary Connect Button */}
                <button
                  type="button"
                  onClick={onQuickConnect}
                  disabled={status === 'connecting'}
                  className={`btn btn-primary connect-btn-primary ${status === 'connecting' ? 'connecting' : ''}`}
                >
                  {status === 'connecting' ? (
                    <>
                      <Loader2 size={16} className="animate-spin" />
                      <span>Connecting...</span>
                    </>
                  ) : (
                    <>
                      <span>Connect</span>
                      <ArrowRight size={15} />
                    </>
                  )}
                </button>

                {/* Subordinate Secondary Actions Strip */}
                <div className="secondary-actions-strip" role="toolbar" aria-label="Device actions">
                  <button
                    type="button"
                    onClick={() => setIsScanning(true)}
                    className="action-pill-btn"
                    title="Scan Desktop QR Code"
                  >
                    <QrCode size={13} />
                    <span>Scan QR</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setIsEditingIp(v => !v)}
                    className={`action-pill-btn ${isEditingIp ? 'active' : ''}`}
                    title="Edit IP address manually"
                    aria-expanded={isEditingIp}
                  >
                    <Edit3 size={13} />
                    <span>{isEditingIp ? 'Close IP' : 'Change IP'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={onOpenPreferences}
                    className="action-pill-btn"
                    title="Rename or configure device"
                  >
                    <Sliders size={13} />
                    <span>Rename</span>
                  </button>

                  <button
                    type="button"
                    onClick={onUnpairPrompt}
                    className="action-pill-btn danger"
                    title="Unpair from this computer"
                  >
                    <Unlink size={13} />
                    <span>Unpair</span>
                  </button>
                </div>

                {/* Smooth Inline IP Editor */}
                {isEditingIp && (
                  <div className="inline-ip-wrapper">
                    <form onSubmit={onManualConnect} className="inline-ip-form">
                      <input
                        type="text"
                        className="form-input form-input-mono"
                        value={address}
                        onChange={e => setAddress(e.target.value)}
                        placeholder="192.168.1.15:8080"
                        autoFocus
                        aria-label="Desktop IP Address and Port"
                      />
                      <button
                        type="submit"
                        className="btn btn-primary"
                        disabled={status === 'connecting'}
                      >
                        Save
                      </button>
                    </form>
                  </div>
                )}
              </div>
            ) : (
              <div className="continuity-card-compact">
                {/* Brand Logo Avatar */}
                <div className="continuity-ring-compact">
                  <div className="continuity-icon-compact">
                    <BrandLogo size={24} connected={false} />
                  </div>
                </div>

                <h2 className="device-name-primary">Connect to Desktop</h2>
                <p className="continuity-subtitle" style={{ fontSize: '0.82rem', marginBottom: '1.1rem' }}>
                  Scan the QR code displayed on your computer to pair securely over local Wi-Fi.
                </p>

                {(cameraError || connectError) && (
                  <div className="connection-alert-box error" role="alert">
                    <AlertCircle size={14} className="alert-icon" />
                    <span>{cameraError || connectError}</span>
                  </div>
                )}

                {/* Primary Action: QR Scan */}
                <button
                  type="button"
                  onClick={() => setIsScanning(true)}
                  className="btn btn-primary connect-btn-primary"
                >
                  <QrCode size={16} />
                  <span>Scan QR Code</span>
                </button>

                {/* Secondary Action: Manual IP Expander */}
                <div className="secondary-actions-strip">
                  <button
                    type="button"
                    onClick={() => setIsEditingIp(v => !v)}
                    className={`action-pill-btn ${isEditingIp ? 'active' : ''}`}
                    aria-expanded={isEditingIp}
                  >
                    <Edit3 size={13} />
                    <span>{isEditingIp ? 'Hide manual setup' : 'Connect via IP address'}</span>
                  </button>
                </div>

                {/* Manual Setup Form Drawer */}
                {isEditingIp && (
                  <div className="inline-ip-wrapper">
                    <form onSubmit={onManualConnect} className="manual-drawer-form" style={{ marginTop: 0, paddingTop: 0, borderTop: 'none' }}>
                      <div className="form-field">
                        <label className="form-label" htmlFor="connection-screen-ip-input">
                          Desktop IP & Port
                        </label>
                        <input
                          id="connection-screen-ip-input"
                          type="text"
                          className="form-input form-input-mono"
                          value={address}
                          onChange={e => setAddress(e.target.value)}
                          placeholder="192.168.1.15:8080"
                          autoFocus
                        />
                      </div>
                      <div className="form-field">
                        <label className="form-label" htmlFor="connection-screen-device-name-input">
                          Device Name
                        </label>
                        <input
                          id="connection-screen-device-name-input"
                          type="text"
                          className="form-input"
                          value={deviceName}
                          onChange={e => setDeviceName(e.target.value)}
                          maxLength={40}
                          placeholder="Mobile device name"
                        />
                      </div>
                      <button
                        type="submit"
                        className="btn btn-primary full-width"
                        disabled={status === 'connecting'}
                      >
                        {status === 'connecting' ? 'Waiting for PC...' : 'Pair & Connect'}
                      </button>
                    </form>
                  </div>
                )}
              </div>
            )}

            {/* Discovery Hint when no devices found */}
            {!pairing && discoveryTip && availableDevices.length === 0 && isEditingIp && (
              <p className="discovery-caption">{discoveryTip}</p>
            )}
          </>
        )}
      </div>

      {/* Security Footnote */}
      <footer className="connection-minimal-footer">
        <Lock size={12} strokeWidth={2} />
        <span>End-to-end AES-256 encrypted · Local Wi-Fi only</span>
      </footer>
    </main>
  );
};

export default ConnectionScreen;
