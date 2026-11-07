import React, { useState, useEffect, useRef } from 'react';
import { ArrowLeft, ChevronRight, Monitor, Moon, Sun } from 'lucide-react';
import { ServerSettings } from '../lib/api';
import { backButtonManager } from '../lib/backButton';
import { Sheet } from './Sheet';
import { Switch } from './ui';
import { AboutPage } from './AboutPage';
import { APP_VERSION } from '../lib/appInfo';

export interface PreferencesModalProps {
  isOpen: boolean;
  isConnected: boolean;
  theme: 'dark' | 'light' | 'system';
  onSetTheme: (theme: 'dark' | 'light' | 'system') => void;
  deviceName: string;
  pcName: string;
  downloadSubDir: string;
  bandwidthLimitBps: number;
  concurrencyMode: 'auto' | number;
  clipboardSyncEnabled: boolean;
  sensitiveFilterEnabled: boolean;
  serverSettings: ServerSettings | null;
  deviceChoices?: Array<{ id: string; name: string }>;
  selectedDeviceId?: string | null;
  onSelectDevice?: (id: string) => void;
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
  { label: '25 MB/s', bps: 25 * 1024 * 1024 },
];

const CONCURRENCY_OPTIONS: Array<{ label: string; value: 'auto' | number }> = [
  { label: 'Auto', value: 'auto' },
  { label: '1 stream', value: 1 },
  { label: '2 streams', value: 2 },
  { label: '4 streams', value: 4 },
  { label: '6 streams', value: 6 },
];

const FOLDER_OPTIONS: Array<{ label: string; value: string }> = [
  { label: 'Downloads / P2P Link', value: 'P2P Link' },
  { label: 'Downloads', value: '' },
];

type Picker = null | 'folder' | 'concurrency' | 'bandwidth';

/** Settings: a grouped list on its own page; choices open in the shared selection sheet. */
export const PreferencesModal: React.FC<PreferencesModalProps> = ({
  isOpen, theme, onSetTheme, deviceName, pcName, downloadSubDir, bandwidthLimitBps, concurrencyMode, clipboardSyncEnabled,
  sensitiveFilterEnabled, serverSettings, onClose, onSave,
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
  const [picker, setPicker] = useState<Picker>(null);
  const [aboutOpen, setAboutOpen] = useState(false);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;
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
    setPicker(null);
    setAboutOpen(false);
  }, [isOpen, deviceName, pcName, downloadSubDir, bandwidthLimitBps, concurrencyMode, clipboardSyncEnabled, sensitiveFilterEnabled, serverSettings]);

  useEffect(() => {
    if (!isOpen) return;
    return backButtonManager.push(() => { onCloseRef.current(); return true; });
  }, [isOpen]);

  if (!isOpen) return null;

  const save = async () => {
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
        autostartEnabled: autostart,
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const folderLabel = FOLDER_OPTIONS.find(o => o.value === subDir)?.label ?? `Downloads / ${subDir}`;
  const concLabel = CONCURRENCY_OPTIONS.find(o => o.value === concMode)?.label ?? 'Auto';
  const bwLabel = BANDWIDTH_OPTIONS.find(o => o.bps === bwBps)?.label ?? `${Math.round(bwBps / 1048576)} MB/s`;
  const customFolder = !FOLDER_OPTIONS.some(o => o.value === subDir);

  return (
    <div className="page" role="dialog" aria-modal="true" aria-labelledby="settings-heading">
      <div className="page-bar">
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Back"><ArrowLeft size={22} /></button>
        <h2 id="settings-heading" className="page-bar-title">Settings</h2>
        <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={saving} style={{ marginRight: 'var(--s-2)' }}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      <div className="scroll" style={{ paddingBottom: 'calc(var(--safe-bottom) + var(--s-8))' }}>
        <div className="section-label">General</div>
        <div className="group settings-group">
          <label className="row">
            <span className="row-main">
              <span className="row-title">Device name</span>
              <span className="row-sub">Shown to computers on this Wi-Fi</span>
            </span>
            <input
              className="row-input"
              value={devAlias}
              onChange={e => setDevAlias(e.target.value)}
              maxLength={36}
              placeholder="My phone"
              aria-label="Device name"
            />
          </label>
          <div className="row">
            <span className="row-main">
              <span className="row-title">Appearance</span>
              <span className="row-sub">Theme for this app</span>
            </span>
            <div className="segmented segmented-sm" role="group" aria-label="Appearance">
              {([['light', 'Light', Sun], ['dark', 'Dark', Moon], ['system', 'Auto', Monitor]] as const).map(([key, label]) => (
                <button key={key} type="button" className={`segmented-item${theme === key ? ' active' : ''}`} aria-pressed={theme === key} onClick={() => onSetTheme(key)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="section-label">Transfers</div>
        <div className="group settings-group">
          <button type="button" className="row" onClick={() => setPicker('folder')}>
            <span className="row-main">
              <span className="row-title">Save location</span>
              <span className="row-sub">Where received files go</span>
            </span>
            <span className="row-value truncate">{folderLabel}</span>
            <ChevronRight size={16} className="row-chevron" />
          </button>
          {customFolder && (
            <label className="row">
              <span className="row-main"><span className="row-title">Folder name</span></span>
              <input className="row-input" value={subDir} onChange={e => setSubDir(e.target.value)} maxLength={40} placeholder="Folder" aria-label="Folder name" />
            </label>
          )}
          <button type="button" className="row" onClick={() => setPicker('concurrency')}>
            <span className="row-main">
              <span className="row-title">Parallel streams</span>
              <span className="row-sub">More streams speed up large batches</span>
            </span>
            <span className="row-value">{concLabel}</span>
            <ChevronRight size={16} className="row-chevron" />
          </button>
          <button type="button" className="row" onClick={() => setPicker('bandwidth')}>
            <span className="row-main">
              <span className="row-title">Speed limit</span>
              <span className="row-sub">Leave bandwidth for others on the Wi-Fi</span>
            </span>
            <span className="row-value">{bwLabel}</span>
            <ChevronRight size={16} className="row-chevron" />
          </button>
        </div>

        <div className="section-label">Privacy</div>
        <div className="group settings-group">
          <div className="row">
            <span className="row-main">
              <span className="row-title">Clipboard sharing</span>
              <span className="row-sub">Sync copied text between devices</span>
            </span>
            <Switch checked={clipSync} label="Clipboard sharing" onChange={setClipSync} />
          </div>
          <div className="row">
            <span className="row-main">
              <span className="row-title">Hide sensitive text</span>
              <span className="row-sub">Skip passwords, tokens and one-time codes</span>
            </span>
            <Switch checked={sensFilter} label="Hide sensitive text" onChange={setSensFilter} />
          </div>
        </div>

        <div className="section-label">About</div>
        <div className="group settings-group">
          <button type="button" className="row" onClick={() => setAboutOpen(true)}>
            <span className="row-main">
              <span className="row-title">About and feedback</span>
              <span className="row-sub">Developer, source code, say hello</span>
            </span>
            <ChevronRight size={16} className="row-chevron" />
          </button>
          <div className="row">
            <span className="row-main"><span className="row-title">Version</span></span>
            <span className="row-value">{APP_VERSION}</span>
          </div>
          <div className="row">
            <span className="row-main">
              <span className="row-title">Encryption</span>
              <span className="row-sub">Direct over your local network</span>
            </span>
            <span className="row-value">AES-256</span>
          </div>
        </div>
      </div>

      {aboutOpen && <AboutPage onClose={() => setAboutOpen(false)} />}

      <Sheet open={picker === 'folder'} onClose={() => setPicker(null)} title="Save location" flush>
        <ul className="rows">
          {FOLDER_OPTIONS.map(o => (
            <li key={o.label}>
              <button type="button" className="row" onClick={() => { setSubDir(o.value); setPicker(null); }}>
                <span className="row-main"><span className="row-title">{o.label}</span></span>
                <span className={`radio${subDir === o.value ? ' on' : ''}`} />
              </button>
            </li>
          ))}
          <li>
            <button type="button" className="row" onClick={() => { if (!customFolder) setSubDir('Received'); setPicker(null); }}>
              <span className="row-main"><span className="row-title">Custom folder</span></span>
              <span className={`radio${customFolder ? ' on' : ''}`} />
            </button>
          </li>
        </ul>
      </Sheet>

      <Sheet open={picker === 'concurrency'} onClose={() => setPicker(null)} title="Parallel streams" flush>
        <ul className="rows">
          {CONCURRENCY_OPTIONS.map(o => (
            <li key={String(o.value)}>
              <button type="button" className="row" onClick={() => { setConcMode(o.value); setPicker(null); }}>
                <span className="row-main"><span className="row-title">{o.label}</span></span>
                <span className={`radio${concMode === o.value ? ' on' : ''}`} />
              </button>
            </li>
          ))}
        </ul>
      </Sheet>

      <Sheet open={picker === 'bandwidth'} onClose={() => setPicker(null)} title="Speed limit" flush>
        <ul className="rows">
          {BANDWIDTH_OPTIONS.map(o => (
            <li key={o.bps}>
              <button type="button" className="row" onClick={() => { setBwBps(o.bps); setPicker(null); }}>
                <span className="row-main"><span className="row-title">{o.label}</span></span>
                <span className={`radio${bwBps === o.bps ? ' on' : ''}`} />
              </button>
            </li>
          ))}
        </ul>
      </Sheet>
    </div>
  );
};

export default PreferencesModal;
