import React, { useState, useEffect } from 'react';
import {
  X,
  Sliders,
  Shield,
  FolderDown,
  Gauge,
  Monitor,
  Smartphone,
  Check,
  HardDrive,
  Info
} from 'lucide-react';
import { ServerSettings } from '../lib/api';
import { backButtonManager } from '../lib/backButton';

export interface PreferencesModalProps {
  isOpen: boolean;
  isConnected: boolean;
  deviceName: string;
  pcName: string;
  downloadSubDir: string;
  bandwidthLimitBps: number;
  concurrencyMode: 'auto' | number;
  clipboardSyncEnabled: boolean;
  sensitiveFilterEnabled: boolean;
  serverSettings: ServerSettings | null;
  onClose: () => void;
  onSave: (prefs: {
    deviceAlias: string;
    pcAlias: string;
    downloadSubDir: string;
    pcReceiveDir: string;
    bandwidthLimitBps: number;
    concurrencyMode: 'auto' | number;
    clipboardSyncEnabled: boolean;
    sensitiveFilterEnabled: boolean;
    contextMenuEnabled: boolean;
    autostartEnabled: boolean;
  }) => Promise<void> | void;
}

const BANDWIDTH_OPTIONS: Array<{ label: string; bps: number }> = [
  { label: 'Unlimited', bps: 0 },
  { label: '2 MB/s', bps: 2 * 1024 * 1024 },
  { label: '5 MB/s', bps: 5 * 1024 * 1024 },
  { label: '10 MB/s', bps: 10 * 1024 * 1024 },
  { label: '25 MB/s', bps: 25 * 1024 * 1024 }
];

const CONCURRENCY_OPTIONS: Array<{ label: string; value: 'auto' | number }> = [
  { label: 'Auto', value: 'auto' },
  { label: '1 stream', value: 1 },
  { label: '2 streams', value: 2 },
  { label: '4 streams', value: 4 },
  { label: '6 streams', value: 6 }
];

export const PreferencesModal: React.FC<PreferencesModalProps> = ({
  isOpen,
  isConnected,
  deviceName,
  pcName,
  downloadSubDir,
  bandwidthLimitBps,
  concurrencyMode,
  clipboardSyncEnabled,
  sensitiveFilterEnabled,
  serverSettings,
  onClose,
  onSave
}) => {
  const [devAlias, setDevAlias] = useState(deviceName);
  const [desktopAlias, setDesktopAlias] = useState(pcName);
  const [subDir, setSubDir] = useState(downloadSubDir);
  const [pcDir, setPcDir] = useState(serverSettings?.receiveDir || '');
  const [bwBps, setBwBps] = useState(bandwidthLimitBps);
  const [concMode, setConcMode] = useState<'auto' | number>(concurrencyMode);
  const [clipSync, setClipSync] = useState(clipboardSyncEnabled);
  const [sensFilter, setSensFilter] = useState(sensitiveFilterEnabled);
  const [ctxMenu, setCtxMenu] = useState(serverSettings?.contextMenuEnabled ?? false);
  const [autostart, setAutostart] = useState(serverSettings?.autostartEnabled ?? false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setDevAlias(serverSettings?.deviceAlias || deviceName);
      setDesktopAlias(serverSettings?.pcAlias || pcName);
      setSubDir(downloadSubDir);
      setPcDir(serverSettings?.receiveDir || '');
      setBwBps(bandwidthLimitBps);
      setConcMode(concurrencyMode);
      setClipSync(clipboardSyncEnabled);
      setSensFilter(sensitiveFilterEnabled);
      setCtxMenu(serverSettings?.contextMenuEnabled ?? false);
      setAutostart(serverSettings?.autostartEnabled ?? false);
    }
  }, [
    isOpen,
    deviceName,
    pcName,
    downloadSubDir,
    bandwidthLimitBps,
    concurrencyMode,
    clipboardSyncEnabled,
    sensitiveFilterEnabled,
    serverSettings
  ]);

  // Support Android physical back button & Esc key
  useEffect(() => {
    if (!isOpen) return;

    const unregister = backButtonManager.push(() => {
      onClose();
      return true;
    });

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      unregister();
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onSave({
        deviceAlias: devAlias.trim(),
        pcAlias: desktopAlias.trim(),
        downloadSubDir: subDir.trim(),
        pcReceiveDir: pcDir.trim(),
        bandwidthLimitBps: bwBps,
        concurrencyMode: concMode,
        clipboardSyncEnabled: clipSync,
        sensitiveFilterEnabled: sensFilter,
        contextMenuEnabled: ctxMenu,
        autostartEnabled: autostart
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="sheet-backdrop p2p-prefs-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="prefs-modal-title"
    >
      <div
        className="sheet-container prefs-sheet-container p2p-prefs-container"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-drag-handle" />

        <div className="sheet-header">
          <div className="sheet-header-left">
            <div className="sheet-icon-badge p2p-prefs-header-badge">
              <Sliders size={18} strokeWidth={2} />
            </div>
            <div>
              <h3 id="prefs-modal-title" className="sheet-title">
                Preferences & Settings
              </h3>
              <p className="sheet-subtitle">
                Device identity, transfer speeds & clipboard sync
              </p>
            </div>
          </div>
          <button
            type="button"
            className="sheet-close-btn p2p-touch-target"
            onClick={onClose}
            aria-label="Close preferences"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="prefs-form p2p-prefs-form">
          {/* Section 1: THIS MOBILE DEVICE (Local) */}
          <div className="p2p-prefs-card">
            <div className="p2p-prefs-card-header">
              <div className="p2p-prefs-card-title-group">
                <div className="p2p-prefs-badge-icon">
                  <Smartphone size={14} strokeWidth={2.2} />
                </div>
                <span className="p2p-prefs-card-title">THIS MOBILE DEVICE</span>
              </div>
              <span className="p2p-prefs-tag">Local</span>
            </div>

            <div className="p2p-prefs-field">
              <label htmlFor="p2p-dev-alias" className="prefs-label">
                Device Name / Alias
              </label>
              <input
                id="p2p-dev-alias"
                type="text"
                className="prefs-input p2p-input-touch"
                value={devAlias}
                onChange={(e) => setDevAlias(e.target.value)}
                placeholder="e.g. Pixel 8 Pro"
                maxLength={40}
              />
              <span className="p2p-field-hint">
                Name broadcasted to desktop during local peer discovery
              </span>
            </div>

            <div className="p2p-prefs-field">
              <label className="prefs-label">
                Downloads Storage Subfolder
              </label>
              <div className="prefs-chip-row p2p-chip-row">
                <button
                  type="button"
                  className={`prefs-option-chip p2p-chip-touch ${subDir === 'P2P Link' ? 'active' : ''}`}
                  onClick={() => setSubDir('P2P Link')}
                >
                  <FolderDown size={13} />
                  <span>Downloads/P2P Link</span>
                </button>
                <button
                  type="button"
                  className={`prefs-option-chip p2p-chip-touch ${subDir === '' ? 'active' : ''}`}
                  onClick={() => setSubDir('')}
                >
                  <HardDrive size={13} />
                  <span>Downloads (Root)</span>
                </button>
              </div>
              <input
                type="text"
                className="prefs-input p2p-input-touch"
                value={subDir}
                onChange={(e) => setSubDir(e.target.value)}
                placeholder="Subfolder name (or leave empty for Downloads root)"
                maxLength={60}
              />
              <span className="p2p-field-hint">
                Incoming files are saved to {subDir ? `/Downloads/${subDir}` : '/Downloads'}
              </span>
            </div>
          </div>

          {/* Section 2: TRANSFER & BANDWIDTH */}
          <div className="p2p-prefs-card">
            <div className="p2p-prefs-card-header">
              <div className="p2p-prefs-card-title-group">
                <div className="p2p-prefs-badge-icon">
                  <Gauge size={14} strokeWidth={2.2} />
                </div>
                <span className="p2p-prefs-card-title">TRANSFER & BANDWIDTH</span>
              </div>
              <span className="p2p-prefs-tag">Network</span>
            </div>

            <div className="p2p-prefs-field">
              <label className="prefs-label">Concurrency Mode</label>
              <div className="prefs-chip-row p2p-chip-row">
                {CONCURRENCY_OPTIONS.map((opt) => (
                  <button
                    key={String(opt.value)}
                    type="button"
                    className={`prefs-option-chip p2p-chip-touch ${concMode === opt.value ? 'active' : ''}`}
                    onClick={() => setConcMode(opt.value)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <span className="p2p-field-hint">
                Auto mode dynamically allocates socket streams for high speed batch transfers.
              </span>
            </div>

            <div className="p2p-prefs-field">
              <label className="prefs-label">Max Transfer Speed</label>
              <div className="prefs-chip-row p2p-chip-row">
                {BANDWIDTH_OPTIONS.map((opt) => (
                  <button
                    key={opt.bps}
                    type="button"
                    className={`prefs-option-chip p2p-chip-touch ${bwBps === opt.bps ? 'active' : ''}`}
                    onClick={() => setBwBps(opt.bps)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <span className="p2p-field-hint">
                Limit transfer bandwidth to prevent saturating local Wi-Fi.
              </span>
            </div>
          </div>

          {/* Section 3: CLIPBOARD & PRIVACY */}
          <div className="p2p-prefs-card">
            <div className="p2p-prefs-card-header">
              <div className="p2p-prefs-card-title-group">
                <div className="p2p-prefs-badge-icon">
                  <Shield size={14} strokeWidth={2.2} />
                </div>
                <span className="p2p-prefs-card-title">CLIPBOARD & PRIVACY</span>
              </div>
              <span className="p2p-prefs-tag">Privacy</span>
            </div>

            <label className="prefs-toggle-row p2p-toggle-row">
              <div className="prefs-toggle-text">
                <div className="prefs-toggle-title">Automatic Clipboard Sync</div>
                <div className="prefs-toggle-sub">
                  Sync copied text between phone and desktop in real-time
                </div>
              </div>
              <div className="p2p-switch-wrapper">
                <input
                  type="checkbox"
                  checked={clipSync}
                  onChange={(e) => setClipSync(e.target.checked)}
                  className="p2p-switch-native-input"
                  aria-label="Automatic Clipboard Sync"
                />
                <div className={`p2p-switch-track ${clipSync ? 'p2p-switch-on' : ''}`}>
                  <div className="p2p-switch-thumb" />
                </div>
              </div>
            </label>

            <label className="prefs-toggle-row p2p-toggle-row">
              <div className="prefs-toggle-text">
                <div className="prefs-toggle-title">Sensitive Data Filter</div>
                <div className="prefs-toggle-sub">
                  Skip private keys, tokens, passwords & credit card numbers
                </div>
              </div>
              <div className="p2p-switch-wrapper">
                <input
                  type="checkbox"
                  checked={sensFilter}
                  onChange={(e) => setSensFilter(e.target.checked)}
                  className="p2p-switch-native-input"
                  aria-label="Sensitive Data Filter"
                />
                <div className={`p2p-switch-track ${sensFilter ? 'p2p-switch-on' : ''}`}>
                  <div className="p2p-switch-thumb" />
                </div>
              </div>
            </label>
          </div>

          {/* Section 4: CONNECTED DESKTOP (Remote Desktop) */}
          <div className="p2p-prefs-card">
            <div className="p2p-prefs-card-header">
              <div className="p2p-prefs-card-title-group">
                <div className="p2p-prefs-badge-icon">
                  <Monitor size={14} strokeWidth={2.2} />
                </div>
                <span className="p2p-prefs-card-title">CONNECTED DESKTOP</span>
              </div>
              <span className={`p2p-prefs-tag ${isConnected ? 'p2p-tag-active' : ''}`}>
                {isConnected ? 'Active Link' : 'Offline'}
              </span>
            </div>

            {isConnected ? (
              <>
                <div className="p2p-prefs-field">
                  <label htmlFor="p2p-pc-alias" className="prefs-label">
                    Desktop PC Name / Alias
                  </label>
                  <input
                    id="p2p-pc-alias"
                    type="text"
                    className="prefs-input p2p-input-touch"
                    value={desktopAlias}
                    onChange={(e) => setDesktopAlias(e.target.value)}
                    placeholder="e.g. Work PC"
                    maxLength={40}
                  />
                  <span className="p2p-field-hint">
                    Label assigned to the paired desktop computer
                  </span>
                </div>

                <div className="p2p-prefs-field">
                  <label htmlFor="p2p-pc-dir" className="prefs-label">
                    Desktop Receive Directory
                  </label>
                  <input
                    id="p2p-pc-dir"
                    type="text"
                    className="prefs-input prefs-input-mono p2p-input-touch"
                    value={pcDir}
                    onChange={(e) => setPcDir(e.target.value)}
                    placeholder="e.g. C:\Users\Username\Downloads\P2P"
                  />
                  <span className="p2p-field-hint">
                    Files sent from this phone are saved here on your PC
                  </span>
                </div>

                <label className="prefs-toggle-row p2p-toggle-row">
                  <div className="prefs-toggle-text">
                    <div className="prefs-toggle-title">Windows Explorer Context Menu</div>
                    <div className="prefs-toggle-sub">
                      Right-click any file on desktop → "Send via P2P Link"
                    </div>
                  </div>
                  <div className="p2p-switch-wrapper">
                    <input
                      type="checkbox"
                      checked={ctxMenu}
                      onChange={(e) => setCtxMenu(e.target.checked)}
                      className="p2p-switch-native-input"
                      aria-label="Windows Explorer Context Menu"
                    />
                    <div className={`p2p-switch-track ${ctxMenu ? 'p2p-switch-on' : ''}`}>
                      <div className="p2p-switch-thumb" />
                    </div>
                  </div>
                </label>

                <label className="prefs-toggle-row p2p-toggle-row">
                  <div className="prefs-toggle-text">
                    <div className="prefs-toggle-title">Launch Desktop Server on Startup</div>
                    <div className="prefs-toggle-sub">
                      Start P2P Link in system tray automatically on Windows boot
                    </div>
                  </div>
                  <div className="p2p-switch-wrapper">
                    <input
                      type="checkbox"
                      checked={autostart}
                      onChange={(e) => setAutostart(e.target.checked)}
                      className="p2p-switch-native-input"
                      aria-label="Launch Desktop Server on Startup"
                    />
                    <div className={`p2p-switch-track ${autostart ? 'p2p-switch-on' : ''}`}>
                      <div className="p2p-switch-thumb" />
                    </div>
                  </div>
                </label>
              </>
            ) : (
              <div className="p2p-prefs-offline-note">
                <Info size={16} className="p2p-prefs-note-icon" />
                <div className="p2p-prefs-note-text">
                  <strong>Desktop is currently disconnected.</strong>
                  <p>
                    Pair with your desktop computer via QR code to configure remote save
                    directories and Windows OS integration.
                  </p>
                </div>
              </div>
            )}
          </div>

          <div className="sheet-actions prefs-footer-actions p2p-prefs-footer-actions">
            <button
              type="button"
              className="sheet-btn sheet-btn-secondary p2p-btn-touch"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="sheet-btn sheet-btn-primary p2p-btn-touch"
              disabled={saving}
            >
              {saving ? (
                <span>Saving...</span>
              ) : (
                <>
                  <Check size={16} strokeWidth={2.5} />
                  <span>Save Settings</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>

      <style>{`
        .p2p-prefs-backdrop {
          position: fixed;
          inset: 0;
          background: var(--backdrop-scrim);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          z-index: 100;
          display: flex;
          align-items: flex-end;
          justify-content: center;
        }

        .p2p-prefs-container {
          width: 100%;
          max-width: 580px;
          max-height: 90vh;
          background: var(--surface-elevated);
          border-top: 1px solid var(--border-strong);
          border-radius: var(--radius-lg) var(--radius-lg) 0 0;
          padding: 0.85rem 1.25rem;
          padding-bottom: calc(1.25rem + env(safe-area-inset-bottom));
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
          box-shadow: var(--shadow-lg);
          animation: p2pPrefsSlideUp 240ms var(--ease-spring);
        }

        @keyframes p2pPrefsSlideUp {
          from {
            transform: translateY(100%);
          }
          to {
            transform: translateY(0);
          }
        }

        .p2p-prefs-header-badge {
          background: var(--accent-subtle);
          color: var(--accent);
          border: 1px solid var(--accent-border);
        }

        .p2p-touch-target {
          min-width: 44px;
          min-height: 44px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }

        .p2p-prefs-form {
          display: flex;
          flex-direction: column;
          gap: 0.85rem;
          overflow-y: auto;
          padding-right: 0.2rem;
          margin-top: 0.15rem;
          -webkit-overflow-scrolling: touch;
        }

        .p2p-prefs-card {
          background: var(--surface);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-md);
          padding: 0.95rem 1rem;
          display: flex;
          flex-direction: column;
          gap: 0.85rem;
          box-shadow: var(--shadow-sm);
        }

        .p2p-prefs-card-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding-bottom: 0.5rem;
          border-bottom: 1px solid var(--border-subtle);
        }

        .p2p-prefs-card-title-group {
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }

        .p2p-prefs-badge-icon {
          width: 26px;
          height: 26px;
          border-radius: 6px;
          background: var(--accent-subtle);
          color: var(--accent);
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .p2p-prefs-card-title {
          font-size: 0.74rem;
          font-weight: 700;
          letter-spacing: 0.05em;
          color: var(--text-primary);
          text-transform: uppercase;
        }

        .p2p-prefs-tag {
          font-size: 0.67rem;
          font-weight: 600;
          padding: 0.18rem 0.55rem;
          border-radius: var(--radius-full);
          background: var(--surface-secondary);
          color: var(--text-tertiary);
          border: 1px solid var(--border-subtle);
        }

        .p2p-prefs-tag.p2p-tag-active {
          background: var(--success-subtle);
          color: var(--success);
          border-color: var(--success-border);
        }

        .p2p-prefs-field {
          display: flex;
          flex-direction: column;
          gap: 0.4rem;
        }

        .p2p-field-hint {
          font-size: 0.71rem;
          color: var(--text-tertiary);
          line-height: 1.35;
        }

        .p2p-input-touch {
          height: 44px;
          border-radius: var(--radius-sm);
          background: var(--surface-secondary);
          border: 1px solid var(--border-subtle);
          color: var(--text-primary);
          font-size: 0.88rem;
          padding: 0 0.85rem;
          transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
        }

        .p2p-input-touch:focus {
          border-color: var(--accent);
          box-shadow: 0 0 0 3px var(--accent-subtle);
          background: var(--surface);
        }

        .p2p-chip-row {
          display: flex;
          flex-wrap: wrap;
          gap: 0.45rem;
        }

        .p2p-chip-touch {
          min-height: 40px;
          padding: 0.45rem 0.95rem;
          border-radius: var(--radius-full);
          font-size: 0.78rem;
          font-weight: 600;
          display: inline-flex;
          align-items: center;
          gap: 0.45rem;
          border: 1px solid var(--border-subtle);
          background: var(--surface-secondary);
          color: var(--text-secondary);
          cursor: pointer;
          transition: background var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast);
        }

        .p2p-chip-touch:hover {
          background: var(--surface-hover);
          color: var(--text-primary);
        }

        .p2p-chip-touch.active {
          background: var(--btn-primary-bg);
          color: var(--btn-primary-text);
          border-color: transparent;
        }

        .p2p-toggle-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.85rem;
          min-height: 52px;
          padding: 0.65rem 0.85rem;
          background: var(--surface-secondary);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-sm);
          cursor: pointer;
          transition: background var(--transition-fast), border-color var(--transition-fast);
        }

        .p2p-toggle-row:hover {
          background: var(--surface-hover);
        }

        .p2p-switch-wrapper {
          position: relative;
          display: inline-flex;
          align-items: center;
          flex-shrink: 0;
          width: 46px;
          height: 28px;
        }

        .p2p-switch-native-input {
          position: absolute;
          inset: 0;
          opacity: 0;
          width: 100%;
          height: 100%;
          cursor: pointer;
          z-index: 2;
          margin: 0;
        }

        .p2p-switch-track {
          width: 46px;
          height: 28px;
          border-radius: var(--radius-full);
          background: var(--surface-hover);
          border: 1px solid var(--border-subtle);
          transition: background var(--transition-fast), border-color var(--transition-fast);
          position: relative;
        }

        .p2p-switch-track.p2p-switch-on {
          background: var(--accent);
          border-color: var(--accent);
        }

        .p2p-switch-thumb {
          width: 22px;
          height: 22px;
          border-radius: var(--radius-full);
          background: #FFFFFF;
          position: absolute;
          top: 2px;
          left: 2px;
          transition: transform var(--transition-fast);
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
        }

        .p2p-switch-track.p2p-switch-on .p2p-switch-thumb {
          transform: translateX(18px);
          background: var(--btn-primary-text);
        }

        .p2p-prefs-offline-note {
          display: flex;
          gap: 0.65rem;
          padding: 0.75rem 0.85rem;
          background: var(--surface-secondary);
          border: 1px dashed var(--border-strong);
          border-radius: var(--radius-sm);
          color: var(--text-secondary);
          font-size: 0.77rem;
          line-height: 1.42;
        }

        .p2p-prefs-note-icon {
          color: var(--accent);
          flex-shrink: 0;
          margin-top: 2px;
        }

        .p2p-prefs-note-text strong {
          color: var(--text-primary);
          display: block;
          margin-bottom: 0.2rem;
        }

        .p2p-prefs-footer-actions {
          margin-top: 0.4rem;
          padding-top: 0.75rem;
          border-top: 1px solid var(--border-subtle);
          display: flex;
          gap: 0.65rem;
        }

        .p2p-btn-touch {
          min-height: 44px;
          font-size: 0.88rem;
          font-weight: 600;
          letter-spacing: -0.01em;
          border-radius: var(--radius-full);
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 0.45rem;
          transition: background var(--transition-fast), transform var(--transition-fast), opacity var(--transition-fast);
        }

        .p2p-btn-touch:active {
          transform: scale(0.985);
        }

        @media (max-width: 360px) {
          .p2p-prefs-container {
            padding: 0.75rem 0.95rem;
          }
          .p2p-prefs-card {
            padding: 0.75rem;
          }
          .p2p-chip-touch {
            font-size: 0.74rem;
            padding: 0.4rem 0.75rem;
          }
        }
      `}</style>
    </div>
  );
};
