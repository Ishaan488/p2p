import React, { useState, useEffect } from 'react';
import { X, Sliders, Shield, FolderDown, Gauge, Tag, Monitor } from 'lucide-react';
import { ServerSettings } from '../lib/api';
import { backButtonManager } from '../lib/backButton';

interface PreferencesModalProps {
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
  { label: '1', value: 1 },
  { label: '2', value: 2 },
  { label: '4', value: 4 },
  { label: '6', value: 6 }
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
  }, [isOpen, deviceName, pcName, downloadSubDir, bandwidthLimitBps, concurrencyMode, clipboardSyncEnabled, sensitiveFilterEnabled, serverSettings]);

  // Support Android physical back button to close sheet
  useEffect(() => {
    if (!isOpen) return;
    const unregister = backButtonManager.push(() => {
      onClose();
      return true;
    });
    return () => {
      unregister();
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
    <div className="sheet-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div
        className="sheet-container prefs-sheet-container"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-drag-handle" />

        <div className="sheet-header">
          <div className="sheet-header-left">
            <div className="sheet-icon-badge">
              <Sliders size={18} />
            </div>
            <div>
              <h3 className="sheet-title">Transfer & Device Settings</h3>
              <p className="sheet-subtitle">Preferences, storage paths & network tuning</p>
            </div>
          </div>
          <button
            type="button"
            className="sheet-close-btn"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="prefs-form">
          {/* Section 1: Device Aliases (FR 4) */}
          <div className="prefs-section">
            <div className="prefs-section-title">
              <Tag size={13} />
              <span>DEVICE ALIASES</span>
            </div>
            <div className="prefs-grid-2">
              <div className="prefs-field">
                <label className="prefs-label">This Device Name</label>
                <input
                  type="text"
                  className="prefs-input"
                  value={devAlias}
                  onChange={(e) => setDevAlias(e.target.value)}
                  placeholder="e.g. Ishan's Phone"
                  maxLength={40}
                />
              </div>
              <div className="prefs-field">
                <label className="prefs-label">Paired Desktop Alias</label>
                <input
                  type="text"
                  className="prefs-input"
                  value={desktopAlias}
                  onChange={(e) => setDesktopAlias(e.target.value)}
                  placeholder="e.g. Work Laptop"
                  maxLength={40}
                />
              </div>
            </div>
          </div>

          {/* Section 2: Download Locations (FR 24) */}
          <div className="prefs-section">
            <div className="prefs-section-title">
              <FolderDown size={13} />
              <span>DOWNLOAD LOCATIONS</span>
            </div>
            <div className="prefs-field">
              <label className="prefs-label">Phone Folder (inside Downloads/)</label>
              <div className="prefs-chip-row">
                <button
                  type="button"
                  className={`prefs-option-chip ${subDir === 'P2P Link' ? 'active' : ''}`}
                  onClick={() => setSubDir('P2P Link')}
                >
                  Downloads/P2P Link
                </button>
                <button
                  type="button"
                  className={`prefs-option-chip ${subDir === '' ? 'active' : ''}`}
                  onClick={() => setSubDir('')}
                >
                  Downloads (Root)
                </button>
              </div>
              <input
                type="text"
                className="prefs-input"
                value={subDir}
                onChange={(e) => setSubDir(e.target.value)}
                placeholder="Subfolder name (leave empty for Downloads root)"
                maxLength={60}
              />
            </div>

            {isConnected && (
              <div className="prefs-field" style={{ marginTop: 8 }}>
                <label className="prefs-label">Desktop Receive Directory</label>
                <input
                  type="text"
                  className="prefs-input prefs-input-mono"
                  value={pcDir}
                  onChange={(e) => setPcDir(e.target.value)}
                  placeholder="e.g. C:\Users\Name\P2P\received"
                />
              </div>
            )}
          </div>

          {/* Section 3: Bandwidth & Concurrency (FR 54, NFR 7) */}
          <div className="prefs-section">
            <div className="prefs-section-title">
              <Gauge size={13} />
              <span>BANDWIDTH & CONCURRENCY</span>
            </div>
            <div className="prefs-field">
              <label className="prefs-label">Max Transfer Speed</label>
              <div className="prefs-chip-row">
                {BANDWIDTH_OPTIONS.map((opt) => (
                  <button
                    key={opt.bps}
                    type="button"
                    className={`prefs-option-chip ${bwBps === opt.bps ? 'active' : ''}`}
                    onClick={() => setBwBps(opt.bps)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="prefs-field" style={{ marginTop: 8 }}>
              <label className="prefs-label">Concurrent File Streams</label>
              <div className="prefs-chip-row">
                {CONCURRENCY_OPTIONS.map((opt) => (
                  <button
                    key={String(opt.value)}
                    type="button"
                    className={`prefs-option-chip ${concMode === opt.value ? 'active' : ''}`}
                    onClick={() => setConcMode(opt.value)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Section 4: Clipboard & Privacy (FR 35, FR 36) */}
          <div className="prefs-section">
            <div className="prefs-section-title">
              <Shield size={13} />
              <span>CLIPBOARD & PRIVACY</span>
            </div>
            <label className="prefs-toggle-row">
              <div className="prefs-toggle-text">
                <div className="prefs-toggle-title">Automatic Clipboard Sync</div>
                <div className="prefs-toggle-sub">Sync copied text between phone and desktop</div>
              </div>
              <input
                type="checkbox"
                checked={clipSync}
                onChange={(e) => setClipSync(e.target.checked)}
                className="prefs-checkbox"
              />
            </label>
            <label className="prefs-toggle-row">
              <div className="prefs-toggle-text">
                <div className="prefs-toggle-title">Block Sensitive Clipboard Content</div>
                <div className="prefs-toggle-sub">Skip private keys, API tokens, passwords & card numbers</div>
              </div>
              <input
                type="checkbox"
                checked={sensFilter}
                onChange={(e) => setSensFilter(e.target.checked)}
                className="prefs-checkbox"
              />
            </label>
          </div>

          {/* Section 5: Desktop OS Integration (FR 42, FR 47) */}
          {isConnected && (
            <div className="prefs-section">
              <div className="prefs-section-title">
                <Monitor size={13} />
                <span>DESKTOP OS INTEGRATION</span>
              </div>
              <label className="prefs-toggle-row">
                <div className="prefs-toggle-text">
                  <div className="prefs-toggle-title">Windows Explorer Context Menu</div>
                  <div className="prefs-toggle-sub">Right-click any file on PC → "Send via P2P Link"</div>
                </div>
                <input
                  type="checkbox"
                  checked={ctxMenu}
                  onChange={(e) => setCtxMenu(e.target.checked)}
                  className="prefs-checkbox"
                />
              </label>
              <label className="prefs-toggle-row">
                <div className="prefs-toggle-text">
                  <div className="prefs-toggle-title">Launch Desktop Server on Startup</div>
                  <div className="prefs-toggle-sub">Start P2P Link in system tray when signing into PC</div>
                </div>
                <input
                  type="checkbox"
                  checked={autostart}
                  onChange={(e) => setAutostart(e.target.checked)}
                  className="prefs-checkbox"
                />
              </label>
            </div>
          )}

          <div className="sheet-actions prefs-footer-actions">
            <button type="button" className="sheet-btn sheet-btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="sheet-btn sheet-btn-primary" disabled={saving}>
              {saving ? 'Saving...' : 'Save Settings'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
