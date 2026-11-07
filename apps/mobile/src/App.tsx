import React, { useState, useEffect, useRef, useSyncExternalStore } from 'react';
import { WebSocketTransport } from './lib/transport';
import { Message } from './lib/protocol';
import { ServerApi, ServerSettings, pairWithApproval, pairWithQr } from './lib/api';
import { randomHex } from './lib/crypto';
import {
  downloadEncrypted,
  downloadDirectToDisk,
  saveToDeviceDownloads,
  getDownloadSubDir,
  setDownloadSubDir,
  clearDownloadCache,
  getCachedDownloadBytes,
  FileSaver
} from './lib/downloads';
import {
  Upload,
  UploadQueue,
  UploadPriority,
  UploadableFile,
  transferIdFor,
  materializeToBlob,
  BatchStats,
  getClientBandwidthLimitBps,
  setClientBandwidthLimitBps
} from './lib/uploads';
import {
  LogOut,
  Trash2, UploadCloud, Settings, Loader2, ChevronRight, Plus,
  ShieldCheck, ShieldAlert, Unlink, MoreVertical,
  ChevronDown, Laptop, X
} from 'lucide-react';
import { Sheet } from './components/Sheet';
import { StateView, Switch } from './components/ui';
import { BrandLogo } from './components/BrandLogo';
import { checkPendingShare, onSharedData, NativeSharedFile } from './lib/shareTarget';
import { Capacitor } from '@capacitor/core';
import { Html5Qrcode } from 'html5-qrcode';
import { Clipboard } from '@capacitor/clipboard';
import { backButtonManager } from './lib/backButton';
import {
  getMediaKind, extractTextSnippet
} from './lib/telemetry';
import {
  saveBlobToCache,
  getBlobFromCache,
  deleteBlobFromCache,
  generateThumbnailDataUrl,
  generateVideoThumbnailDataUrl,
  savePendingUpload,
  loadPendingUploads,
  removePendingUpload,
  isSensitiveClipboardText
} from './lib/storage';
import { startAutoDiscovery, deviceKey, forgetDiscoveredDevice, reprobeDiscoveredDevice, DiscoveredDevice } from './lib/discovery';
import { PeerManager, type PeerEvent, type PeerView } from './lib/peerManager';
import { attributeLegacyItems, describeTargets, type KeyValueStore } from './lib/peers';
import { messageIdForPeer, shareRoute, shareSettleDelay, summarizeSend, transferIdForPeer } from './lib/sendPlan';
import { describeConnectFailure } from './lib/connectErrors';
import { retainSharedUri, releaseSharedUri } from './lib/shareTarget';
import { DevicesSheet } from './components/DevicesSheet';
import { handleDiscoveredConnectFailure } from './lib/connectRace';
import { ToastContainer, ToastMessage } from './components/Toast';
import { MediaViewer, MediaViewerProps } from './components/MediaViewer';
import { BatchProgress } from './components/BatchProgress';
import { TransferCard, TransferItem } from './components/TransferCard';
import { TransferActionPanel } from './components/TransferActionPanel';
import { SendTextModal } from './components/SendTextModal';
import { ConfirmationDialog } from './components/ConfirmationDialog';
import { PreferencesModal } from './components/PreferencesModal';
import { ConnectionScreen } from './components/ConnectionScreen';

function isImageFilename(name: string): boolean {
  return /\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i.test(name);
}

// localStorage can throw (private mode, quota): the app must keep working without it.
const safeStore: KeyValueStore = {
  getItem: k => { try { return localStorage.getItem(k); } catch { return null; } },
  setItem: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  removeItem: k => { try { localStorage.removeItem(k); } catch { /* ignore */ } }
};

// Every paired PC, each with its own session, socket and reconnect loop.
const peerManager = new PeerManager({
  store: safeStore,
  createApi: (pairing, address) => {
    const a = new ServerApi();
    a.pairing = pairing;
    a.host = address.split('/')[0];
    return a;
  },
  createTransport: () => new WebSocketTransport()
});
const apiFor = (peerId: string | undefined): ServerApi | undefined =>
  peerId ? (peerManager.api(peerId) as ServerApi | undefined) : undefined;

const uploadQueue = new UploadQueue();
const uploads = new Map<string, Upload>(); // live uploads by message id
const uploadPeer = new Map<string, string>(); // message id -> the PC the upload is going to
const activeDownloads = new Map<string, AbortController>(); // live downloads by message id

/** Re-queues the uploads that stopped while this PC was unreachable. */
const resumeUploadsFor = (peerId: string) =>
  uploadQueue.resumeInterrupted([...uploads].filter(([id]) => uploadPeer.get(id) === peerId).map(([, u]) => u));

/** Something shared into the app (Android share sheet) that has not been sent yet. */
interface PendingShare {
  text?: string;
  files: NativeSharedFile[];
}

const defaultAddress = () => {
  if (Capacitor.isNativePlatform() || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return '';
  }
  return window.location.port ? window.location.host : `${window.location.hostname}:8080`;
};


const getDeviceId = () => {
  let id = localStorage.getItem('p2p_device_id');
  if (!id) {
    id = randomHex(8);
    localStorage.setItem('p2p_device_id', id);
  }
  return id;
};

const guessDeviceName = () => {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  if (/Windows/.test(ua)) return 'Windows browser';
  if (/Mac OS X/.test(ua)) return 'Mac browser';
  if (/Linux/.test(ua)) return 'Linux browser';
  return 'Android Device';
};


const parsePairingLink = (text: string): { host: string; code?: string; scheme?: string; cert?: string } => {
  try {
    const url = new URL(text);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      const hashParams = new URLSearchParams(url.hash.slice(1));
      return {
        host: url.host,
        scheme: url.protocol.replace(':', ''),
        code: hashParams.get('pair') || undefined,
        cert: hashParams.get('cert') || undefined
      };
    }
  } catch {
    // not a URL
  }
  return { host: text.trim() };
};


const ACTIVE_UPLOAD: string[] = ['queued', 'uploading', 'paused', 'error'];

function getDateGroup(timestamp: number): 'Today' | 'Yesterday' | 'Earlier this week' | 'Older' {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86400000;
  const startOfWeek = startOfToday - 6 * 86400000;

  if (timestamp >= startOfToday) return 'Today';
  if (timestamp >= startOfYesterday) return 'Yesterday';
  if (timestamp >= startOfWeek) return 'Earlier this week';
  return 'Older';
}

// Upper bound on PCs tracked from discovery, so a very crowded network cannot grow state without limit.
const MAX_DISCOVERED_DEVICES = 200;
// Older history is dropped from storage so it cannot grow without limit across many devices.
const MAX_STORED_MESSAGES = 500;

export default function App() {
  // All paired PCs and their live state. `status` is the overall picture: connected if any PC is.
  const snap = useSyncExternalStore(peerManager.subscribe, peerManager.getSnapshot);
  const status = snap.aggregate;
  const focused = snap.focused; // the PC that "this device" settings and the header refer to
  const [address, setAddress] = useState(defaultAddress);
  const [deviceName, setDeviceName] = useState(() => localStorage.getItem('p2p_device_name') || guessDeviceName());
  const [connectError, setConnectError] = useState('');
  const [discoveredDevices, setDiscoveredDevices] = useState<DiscoveredDevice[]>([]);
  const [discoveryTip, setDiscoveryTip] = useState<string>('');
  const [isScanning, setIsScanning] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [isEditingIp, setIsEditingIp] = useState(false);

  // User-configurable Transfer & Privacy Preferences (FR 4, 24, 35, 36, 42, 47, 54)
  const [isPrefsOpen, setIsPrefsOpen] = useState(false);
  const [downloadSubDir, setDownloadSubDirState] = useState<string>(() => getDownloadSubDir());
  const [bandwidthLimitBps, setBandwidthLimitState] = useState<number>(() => getClientBandwidthLimitBps());
  const [concurrencyMode, setConcurrencyModeState] = useState<'auto' | number>(() => uploadQueue.getConcurrencyMode());
  const [clipboardSyncEnabled, setClipboardSyncEnabled] = useState<boolean>(
    () => localStorage.getItem('p2p_clipboard_sync') !== 'false'
  );
  const [sensitiveFilterEnabled, setSensitiveFilterEnabled] = useState<boolean>(
    () => localStorage.getItem('p2p_sensitive_filter') !== 'false'
  );
  const [serverSettings, setServerSettings] = useState<ServerSettings | null>(null);

  // Theme support: light | dark | system
  const [theme, setTheme] = useState<'dark' | 'light' | 'system'>(() => {
    return (localStorage.getItem('p2p_theme') as 'dark' | 'light' | 'system') || 'dark';
  });

  // Filter: all | received | sent
  const [filter, setFilter] = useState<'all' | 'received' | 'sent'>('all');

  // Modals & Dialogs
  const [isSendTextOpen, setIsSendTextOpen] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    confirmLabel?: string;
    variant?: 'danger' | 'warning' | 'primary';
    icon?: 'trash' | 'unlink' | 'warning';
    onConfirm: () => void;
  }>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {}
  });

  const [messages, setMessages] = useState<TransferItem[]>(() => {
    const saved = localStorage.getItem('p2p_messages');
    const restored: TransferItem[] = saved ? JSON.parse(saved) : [];
    const interrupted = restored.map(m => m.file?.status && ACTIVE_UPLOAD.includes(m.file.status) && !uploads.has(m.id)
      ? { ...m, file: { ...m.file, status: 'interrupted', speed: 0 } }
      : m);
    // Items from before multi-device support belong to the only paired PC, if there is exactly one.
    return attributeLegacyItems(interrupted, peerManager.getSnapshot().peers.map(p => ({ id: p.id, name: p.name })));
  });



  // Text queued for a PC that dropped between choosing it and sending, by PC.
  const [pendingOutbox, setPendingOutbox] = useState<Record<string, Message[]>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem('p2p_outbox') || '{}');
      if (Array.isArray(raw)) {
        // Older versions kept one list for the one PC.
        const only = peerManager.getSnapshot().peers;
        return only.length === 1 && raw.length > 0 ? { [only[0].id]: raw } : {};
      }
      return raw && typeof raw === 'object' ? raw : {};
    } catch {
      return {};
    }
  });

  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [isDragging, setIsDragging] = useState(false);
  const [batchStats, setBatchStats] = useState<BatchStats>(() => uploadQueue.getStats());
  const [isBatchPaused, setIsBatchPaused] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isDevicesOpen, setIsDevicesOpen] = useState(false);
  const [devicesMode, setDevicesMode] = useState<'manage' | 'pick'>('manage');
  const [isAddingDevice, setIsAddingDevice] = useState(false);
  const [pendingShare, setPendingShare] = useState<PendingShare | null>(null);
  const [peerFilter, setPeerFilter] = useState<string>('all');

  // Always-current copies for callbacks that outlive a render (socket events, timers).
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const outboxRef = useRef(pendingOutbox);
  outboxRef.current = pendingOutbox;
  const pendingShareRef = useRef(pendingShare);
  pendingShareRef.current = pendingShare;
  const latest = useRef<{
    onPeerMessage: (peerId: string, data: string) => void;
    onPeerEvent: (ev: PeerEvent) => void;
    handleDownload: (id: string, file: NonNullable<TransferItem['file']>, saveToDisk?: boolean, peerId?: string) => Promise<void>;
    handleIncomingShare: (data: { text?: string; files?: Array<{ name: string; size: number; mimeType: string; path?: string; uri?: string }> }) => void;
  } | null>(null);
  const dragDepth = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const scrollAreaRef = useRef<HTMLElement>(null);
  const [hasUnseenActivity, setHasUnseenActivity] = useState(false);
  const prevMsgCountRef = useRef(messages.length);
  const lastSyncedClipboardRef = useRef<string>('');
  const pendingDeleteTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const [activeMedia, setActiveMedia] = useState<Omit<MediaViewerProps, 'onClose'> | null>(null);

  // Register overflow menu with Android hardware back button
  useEffect(() => {
    if (!isMenuOpen) return;
    return backButtonManager.push(() => {
      setIsMenuOpen(false);
      return true;
    });
  }, [isMenuOpen]);

  // Surface new activity when user is scrolled down in the stream
  useEffect(() => {
    if (messages.length > prevMsgCountRef.current) {
      const el = scrollAreaRef.current;
      if (el && el.scrollTop > 160) {
        setHasUnseenActivity(true);
      }
    }
    prevMsgCountRef.current = messages.length;
  }, [messages.length]);

  // Apply Theme
  useEffect(() => {
    localStorage.setItem('p2p_theme', theme);
    const applyTheme = () => {
      const resolved =
        theme === 'system'
          ? window.matchMedia('(prefers-color-scheme: dark)').matches
            ? 'dark'
            : 'light'
          : theme;
      document.documentElement.setAttribute('data-theme', resolved);
      const metaTheme = document.querySelector('meta[name="theme-color"]');
      if (metaTheme) {
        metaTheme.setAttribute('content', resolved === 'dark' ? '#17161D' : '#F6F4F8');
      }
    };
    applyTheme();

    if (theme === 'system') {
      const media = window.matchMedia('(prefers-color-scheme: dark)');
      media.addEventListener('change', applyTheme);
      return () => media.removeEventListener('change', applyTheme);
    }
  }, [theme]);

  const showToast = (
    text: string,
    type: 'info' | 'success' | 'warning' | 'error' = 'info',
    options?: { action?: { label: string; onClick: () => void }; durationMs?: number }
  ) => {
    const id = `toast-${Date.now()}-${Math.random()}`;
    const duration =
      options?.durationMs ??
      (options?.action ? 5000 : type === 'warning' || type === 'error' ? 4200 : 2800);
    setToasts(prev => [...prev, { id, text, type, action: options?.action }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, duration);
  };

  const dismissToast = (id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  // Recover pending transfers persisted before an application restart (FR 19, NFR 16)
  useEffect(() => {
    let mounted = true;
    loadPendingUploads().then(restored => {
      if (!mounted || restored.length === 0) return;
      for (const { meta, file } of restored) {
        if (uploads.has(meta.messageId)) continue;
        // Uploads saved before multi-device support have no PC: they belong to the only one, if there is only one.
        const peers = peerManager.getSnapshot().peers;
        const peerId = meta.peerId ?? (peers.length === 1 ? peers[0].id : undefined);
        const api = apiFor(peerId);
        if (!peerId || !api) {
          removePendingUpload(meta.transferId).catch(() => {}); // its PC was removed: nothing to resume to
          continue;
        }
        const upload = new Upload(api, file, meta.transferId, p => {
          const progress = p.status === 'queued' ? {} : { progress: p.totalBytes ? (p.sentBytes / p.totalBytes) * 100 : 100 };
          updateFile(meta.messageId, {
            status: p.status,
            priority: p.priority,
            speed: p.speed,
            eta: p.eta,
            error: p.error,
            ...progress
          });
          if (p.status === 'done' || p.status === 'canceled') {
            uploads.delete(meta.messageId);
            uploadPeer.delete(meta.messageId);
          }
        }, meta.priority);

        uploads.set(meta.messageId, upload);
        uploadPeer.set(meta.messageId, peerId);
        updateFile(meta.messageId, { status: 'paused', priority: meta.priority });
      }
      for (const p of peerManager.getSnapshot().connected) resumeUploadsFor(p.id);
    });
    return () => { mounted = false; };
  }, []);

  // Discovery runs when it is needed: nothing is connected, the device list is open, a device is
  // being added, or a paired PC is unreachable (it may simply have a new address).
  // Keyed on one boolean so connecting/error churn does not restart the scan.
  const discoveryActive = snap.connected.length === 0 || isDevicesOpen || isAddingDevice ||
    snap.peers.some(p => p.status === 'offline' || p.status === 'reconnecting');
  useEffect(() => {
    if (!discoveryActive) return;
    setDiscoveredDevices([]); // anything remembered from an earlier scan may be gone by now
    setDiscoveryTip('');
    const stop = startAutoDiscovery(
      // A PC appeared or its details changed.
      device => {
        // A paired PC found at a new address (DHCP, Wi-Fi switch): follow it and reconnect.
        if (device.id && device.state === 'confirmed' && peerManager.has(device.id)) {
          peerManager.updateAddress(device.id, `${device.host}:${device.port}`);
        }
        setDiscoveredDevices(prev => {
          const key = deviceKey(device);
          const i = prev.findIndex(d => deviceKey(d) === key);
          if (i === -1) return prev.length >= MAX_DISCOVERED_DEVICES ? prev : [...prev, device];
          const next = prev.slice();
          next[i] = device;
          return next;
        });
      },
      tip => setDiscoveryTip(tip),
      // A PC said goodbye or stopped announcing.
      key => setDiscoveredDevices(prev => prev.filter(d => deviceKey(d) !== key)),
      { knownAddresses: peerManager.getSnapshot().peers.map(p => p.address).filter(Boolean) }
    );
    return stop;
  }, [discoveryActive]);

  // Back button and lifecycle cleanup init
  useEffect(() => {
    backButtonManager.init(showToast);
    if (Capacitor.isNativePlatform()) {
      FileSaver.cleanupAbandonedPendingDownloads().catch(() => {});
    }
  }, []);

  // Batch progress listener
  useEffect(() => {
    return uploadQueue.onBatchChange((stats) => {
      setBatchStats(stats);
      if (stats.activeCount === 0 && stats.pendingCount === 0) {
        setIsBatchPaused(false);
      }
    });
  }, []);

  // Persist messages in localStorage
  useEffect(() => {
    const toSave = messages.slice(-MAX_STORED_MESSAGES).map(m => {
      if (!m.file) return m;
      const { blobUrl, ...restFile } = m.file;
      return { ...m, file: restFile };
    });
    localStorage.setItem('p2p_messages', JSON.stringify(toSave));
  }, [messages]);

  // Persist pending outbox
  useEffect(() => {
    localStorage.setItem('p2p_outbox', JSON.stringify(pendingOutbox));
  }, [pendingOutbox]);

  const updateFile = (id: string, patch: Partial<NonNullable<TransferItem['file']>>) => {
    setMessages(prev => prev.map(m => m.id === id && m.file ? { ...m, file: { ...m.file, ...patch } } : m));
  };

  // Restore cached media blobs from IndexedDB
  useEffect(() => {
    let active = true;
    const restoreBlobs = async () => {
      for (const m of messages) {
        if (m.file && m.file.transferId && !m.file.blobUrl) {
          const cached = await getBlobFromCache(m.file.cacheKey ?? m.file.transferId);
          if (cached && active) {
            const url = URL.createObjectURL(cached);
            let thumb = m.file.thumbnailUrl;
            const isImg = m.file.mediaKind === 'image' || isImageFilename(m.file.filename);
            if (!thumb && isImg) {
              thumb = await generateThumbnailDataUrl(cached);
            }
            updateFile(m.id, { blobUrl: url, thumbnailUrl: thumb || m.file.thumbnailUrl });
          }
        }
      }
    };
    restoreBlobs();
    return () => { active = false; };
  }, [messages.length]);

  // If the last device drops, the workspace (and its sheet) goes away: do not reopen the sheet on reconnect.
  useEffect(() => {
    if (snap.connected.length === 0) setIsDevicesOpen(false);
  }, [snap.connected.length]);

  // The desktop-side settings shown in Preferences belong to the focused PC.
  useEffect(() => {
    if (focused && focused.status === 'connected') refreshServerSettings(focused.id);
    else setServerSettings(null);
  }, [focused?.id, focused?.status]);

  // Each PC reconnects on its own (with backoff). When the network returns, skip the wait.
  useEffect(() => {
    const handleOnline = () => {
      if (peerManager.getSnapshot().peers.some(p => p.autoConnect && p.status !== 'connected')) {
        showToast('Network restored — reconnecting...', 'info');
      }
      peerManager.wakeAll();
    };
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, []);

  // Android Share Target integration: what arrives is routed by handleIncomingShare.
  useEffect(() => {
    const route = (data: Parameters<NonNullable<typeof latest.current>['handleIncomingShare']>[0]) =>
      latest.current?.handleIncomingShare(data);
    checkPendingShare().then(data => {
      if (data) route(data);
    });
    const cleanup = onSharedData(data => route(data));
    return () => {
      cleanup.then(unsub => unsub());
    };
  }, []);

  const cancelUpload = (id: string, transferId: string) => {
    const dlCtrl = activeDownloads.get(id);
    if (dlCtrl) {
      dlCtrl.abort();
      activeDownloads.delete(id);
      updateFile(id, { status: 'canceled', isDownloading: false, speed: undefined, eta: undefined });
      return;
    }

    const upload = uploads.get(id);
    if (upload) {
      uploadQueue.cancel(upload);
    } else {
      removePendingUpload(transferId).catch(() => {});
      apiFor(peerOfItem(id))?.call('/upload_cancel', { transferId }).catch(() => { });
      updateFile(id, { status: 'canceled', isDownloading: false });
    }
  };

  const requestCancelTransfer = (id: string, transferId: string) => {
    const item = messagesRef.current.find(m => m.id === id);
    const filename = item?.file?.filename || 'this file';
    setConfirmDialog({
      isOpen: true,
      title: 'Cancel transfer?',
      message: `Stop transferring "${filename}"?`,
      confirmLabel: 'Cancel Transfer',
      variant: 'danger',
      icon: 'warning',
      onConfirm: () => {
        setConfirmDialog(prev => ({ ...prev, isOpen: false }));
        cancelUpload(id, transferId);
        showToast(`Canceled ${filename}`, 'info');
      }
    });
  };

  const purgeItemCache = (item: TransferItem) => {
    const file = item.file;
    if (!file) return;
    clearDownloadCache(file.transferId);
    deleteBlobFromCache(file.transferId).catch(() => {});
    const key = file.cacheKey;
    if (key && !messagesRef.current.some(m => m.id !== item.id && m.file?.cacheKey === key)) {
      clearDownloadCache(key);
      deleteBlobFromCache(key).catch(() => {});
    }
  };

  const performImmediateDelete = (id: string, withUndo = false) => {
    const targetItem = messagesRef.current.find(m => m.id === id);
    if (!targetItem) return;
    const file = targetItem.file;
    if (file && file.status && file.status !== 'done' && file.status !== 'canceled' && file.status !== 'error') {
      cancelUpload(id, file.transferId);
    }
    setDeletingIds(prev => new Set(prev).add(id));
    setTimeout(() => {
      setMessages(prev => prev.filter(m => m.id !== id));
      setDeletingIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      if (withUndo) {
        const timer = setTimeout(() => {
          pendingDeleteTimersRef.current.delete(id);
          purgeItemCache(targetItem);
        }, 5200);
        pendingDeleteTimersRef.current.set(id, timer);
        showToast('Removed from history', 'info', {
          action: {
            label: 'Undo',
            onClick: () => {
              const t = pendingDeleteTimersRef.current.get(id);
              if (t) {
                clearTimeout(t);
                pendingDeleteTimersRef.current.delete(id);
              }
              setMessages(prev => (prev.some(m => m.id === id) ? prev : [...prev, targetItem]));
            }
          }
        });
      } else {
        purgeItemCache(targetItem);
      }
    }, 220);
  };

  const handleDelete = (id: string, skipConfirm = false) => {
    const targetItem = messagesRef.current.find(m => m.id === id);
    if (!targetItem) return;
    const file = targetItem.file;
    const isActiveTransfer =
      Boolean(file?.isDownloading) ||
      Boolean(file?.status && ['queued', 'uploading', 'downloading', 'paused', 'interrupted'].includes(file.status));

    if (!skipConfirm && isActiveTransfer) {
      setConfirmDialog({
        isOpen: true,
        title: 'Cancel and remove transfer?',
        message: `"${file?.filename || 'This transfer'}" is still in progress. Removing it will stop the transfer.`,
        confirmLabel: 'Cancel & Remove',
        variant: 'danger',
        icon: 'trash',
        onConfirm: () => {
          setConfirmDialog(prev => ({ ...prev, isOpen: false }));
          performImmediateDelete(id, false);
        }
      });
      return;
    }

    performImmediateDelete(id, !skipConfirm);
  };

  const peerOfItem = (id: string): string | undefined => messagesRef.current.find(m => m.id === id)?.peerId;
  const nameOfPeer = (peerId: string | undefined): string =>
    peerManager.getSnapshot().peers.find(p => p.id === peerId)?.name ?? 'device';

  /** Pulls the desktop-side settings of a PC, and keeps its local name in step with a rename done on the desktop. */
  const refreshServerSettings = (peerId: string) => {
    const peerApi = apiFor(peerId);
    if (!peerApi) return;
    peerApi.getSettings().then(settings => {
      if (peerManager.getSnapshot().focused?.id === peerId) setServerSettings(settings);
      if (settings.pcAlias) peerManager.setServerName(peerId, settings.pcAlias);
    }).catch(() => {});
  };

  /** Stops the downloads from a PC and marks them resumable (it dropped, was disconnected or removed). */
  const interruptDownloadsOf = (peerId: string, reason: string) => {
    const ids = messagesRef.current.filter(m => m.peerId === peerId && activeDownloads.has(m.id)).map(m => m.id);
    for (const id of ids) {
      activeDownloads.get(id)?.abort();
      activeDownloads.delete(id);
    }
    setMessages(prev => prev.map(m => {
      if (m.peerId === peerId && m.sender === 'other' && m.file && (m.file.isDownloading || m.file.status === 'downloading')) {
        return { ...m, file: { ...m.file, isDownloading: false, status: 'interrupted', speed: undefined, eta: undefined, error: reason } };
      }
      return m;
    }));
  };

  /** Delivers text that was queued for a PC while it was unreachable. */
  const flushOutbox = (peerId: string) => {
    const queued = outboxRef.current[peerId];
    if (!queued || queued.length === 0) return;
    const delivered = new Set<string>();
    for (const msg of queued) {
      if (peerManager.send(peerId, JSON.stringify(msg))) delivered.add(msg.id);
    }
    if (delivered.size === 0) return;
    setPendingOutbox(prev => {
      const remaining = (prev[peerId] ?? []).filter(m => !delivered.has(m.id));
      const next = { ...prev };
      if (remaining.length > 0) next[peerId] = remaining;
      else delete next[peerId];
      return next;
    });
    setMessages(prev => prev.map(m => (delivered.has(m.id) ? { ...m, isPending: false } : m)));
    showToast(`Delivered ${delivered.size} pending message${delivered.size > 1 ? 's' : ''} to ${nameOfPeer(peerId)}`, 'success');
  };

  // After a cold start several PCs connect one after another. A share must not go to whichever came up
  // first: give the others a moment, then decide (a single connected device sends, several ask).
  const shareTimer = useRef<number | null>(null);
  const settleShare = (attempt = 0) => {
    if (shareTimer.current !== null) window.clearTimeout(shareTimer.current);
    shareTimer.current = null;
    const share = pendingShareRef.current;
    if (!share) return;
    const wait = shareSettleDelay(peerManager.getSnapshot().peers.map(p => p.status), attempt);
    if (wait !== null) {
      shareTimer.current = window.setTimeout(() => settleShare(attempt + 1), wait);
      return;
    }
    routeShare(share);
  };

  /** What happens when one PC's link comes up, drops, or is removed. The others are unaffected. */
  const onPeerEvent = (ev: PeerEvent) => {
    const name = nameOfPeer(ev.peerId);
    if (ev.type === 'connected') {
      resumeUploadsFor(ev.peerId);
      // Downloads from this PC that were cut off pick up where they stopped.
      const interrupted = messagesRef.current.filter(m =>
        m.peerId === ev.peerId && m.sender === 'other' && m.file && !m.file.isDownloading &&
        (m.file.status === 'interrupted' || m.file.status === 'error' || (m.file.error && m.file.progress && m.file.progress > 0 && m.file.progress < 100))
      );
      if (interrupted.length > 0) {
        setTimeout(() => {
          for (const item of interrupted) {
            if (item.file) latest.current?.handleDownload(item.id, item.file, item.file.saveToDisk ?? true, ev.peerId);
          }
        }, 600);
      }
      flushOutbox(ev.peerId);
      // Something shared into the app while nothing was connected can go out now.
      settleShare();
    } else if (ev.type === 'dropped') {
      interruptDownloadsOf(ev.peerId, 'Disconnected — will resume when reconnected');
      if (peerManager.getSnapshot().connected.length > 0) showToast(`${name} disconnected. Reconnecting…`, 'info');
    } else if (ev.type === 'removed') {
      interruptDownloadsOf(ev.peerId, 'This device was removed');
      for (const [msgId, peerId] of [...uploadPeer]) {
        if (peerId !== ev.peerId) continue;
        const u = uploads.get(msgId);
        if (u) uploadQueue.cancel(u);
        uploads.delete(msgId);
        uploadPeer.delete(msgId);
      }
      setPendingOutbox(prev => {
        if (!(ev.peerId in prev)) return prev;
        const next = { ...prev };
        delete next[ev.peerId];
        return next;
      });
      setPeerFilter(f => (f === ev.peerId ? 'all' : f));
    }
  };

  /** Connect to a PC that is already paired. */
  const connectPeer = async (id: string, targetAddress?: string) => {
    setConnectError('');
    const result = await peerManager.connect(id, targetAddress);
    if (!result.ok && result.kind === 'limit') {
      setConnectError(result.message);
      showToast(result.message, 'warning');
    } else if (!result.ok && result.kind !== 'other') {
      setConnectError(result.message);
    }
    return result;
  };

  const [isPairing, setIsPairing] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<{ host: string; name: string; abort: AbortController } | null>(null);
  const [connectingDiscoveredKey, setConnectingDiscoveredKey] = useState<string | null>(null);

  const cancelPairing = () => {
    if (pendingApproval) {
      pendingApproval.abort.abort(new Error('Pairing canceled by user'));
      setPendingApproval(null);
      setIsPairing(false);
      showToast('Pairing canceled', 'info');
    }
  };

  // Hardware back button cancels pending pairing request
  useEffect(() => {
    if (!pendingApproval) return;
    return backButtonManager.push(() => {
      cancelPairing();
      return true;
    });
  }, [pendingApproval]);

  // Pairs with a new PC (QR secret, or approval on the PC) and connects. Resolves with the failure, if any,
  // so callers can react; the error text has already been set for it.
  const pairAndConnect = async (
    host: string,
    secret?: string,
    scheme = 'http',
    cert?: string,
    peerDisplayName?: string
  ): Promise<unknown> => {
    setConnectError('');
    setAddress(host);
    setIsPairing(true);
    const abort = new AbortController();
    if (!secret) {
      setPendingApproval({ host, name: peerDisplayName || host, abort });
    }
    try {
      const name = deviceName.trim() || guessDeviceName();
      localStorage.setItem('p2p_device_name', name);
      const secure: 'http' | 'https' = scheme === 'https' ? 'https' : 'http';
      if (!secret) showToast(`Approve the pairing prompt on ${peerDisplayName || 'your PC'}`, 'info');
      const paired = secret
        ? await pairWithQr(host, secret, getDeviceId(), name, scheme, cert, abort.signal)
        : await pairWithApproval(host, getDeviceId(), name, scheme, abort.signal);
      setPendingApproval(null);
      const added = peerManager.add({ ...paired, scheme: secure, certFingerprint: cert ?? paired.certFingerprint }, host);
      if (!added.ok) {
        setConnectError(added.message);
        showToast(added.message, 'warning');
        return new Error(added.message);
      }
      setIsAddingDevice(false);
      const result = await peerManager.connect(added.id, host);
      if (!result.ok) {
        setConnectError(result.message);
        // The add screen has closed. If other devices are connected the user is back on the workspace,
        // where only a toast is visible: say plainly why the new one is not connected.
        if (peerManager.getSnapshot().connected.length > 0) {
          showToast(
            result.kind === 'limit' ? result.message : `${nameOfPeer(added.id)} was added but is not reachable right now. It will keep trying.`,
            'warning'
          );
        }
        return result.error;
      }
      showToast(added.replaced ? `${nameOfPeer(added.id)} paired again` : `Connected to ${nameOfPeer(added.id)}`, 'success');
      return undefined;
    } catch (err) {
      if (abort.signal.aborted) {
        return 'canceled';
      }
      setConnectError(describeConnectFailure(err, host));
      return err;
    } finally {
      setPendingApproval(null);
      setIsPairing(false);
    }
  };

  // Tap on a PC in the "Available on Wi-Fi" list. If it went offline a moment before
  // the list caught up, say so plainly instead of showing a raw network error.
  const connectDiscovered = async (d: DiscoveredDevice) => {
    const target = `${d.host}:${d.port}`;
    const key = deviceKey(d);
    setConnectingDiscoveredKey(key);
    let failure: unknown;
    try {
      if (d.id && peerManager.has(d.id)) {
        const result = await connectPeer(d.id, target);
        if (!result.ok && result.kind !== 'limit') failure = result.error;
      } else {
        failure = await pairAndConnect(target, undefined, d.scheme, d.cert, d.serverName || d.name);
      }
    } finally {
      setConnectingDiscoveredKey(prev => (prev === key ? null : prev));
    }
    if (failure === undefined || failure === 'canceled') return;
    await handleDiscoveredConnectFailure(d, failure, {
      forget: forgetDiscoveredDevice,
      reprobe: reprobeDiscoveredDevice,
      showMessage: text => setConnectError(text)
    });
  };

  const disconnectPeer = (id: string) => {
    peerManager.disconnect(id);
    interruptDownloadsOf(id, 'Disconnected — reconnect to resume');
    showToast(`Disconnected from ${nameOfPeer(id)}`, 'info');
  };

  const disconnectAll = () => {
    const connected = peerManager.getSnapshot().connected;
    connected.forEach(p => {
      peerManager.disconnect(p.id);
      interruptDownloadsOf(p.id, 'Disconnected — reconnect to resume');
    });
    showToast(connected.length > 1 ? 'Disconnected from all devices' : `Disconnected from ${connected[0]?.name ?? 'desktop'}`, 'info');
  };

  const unpairPeer = (id: string) => {
    const name = nameOfPeer(id);
    setConfirmDialog({
      isOpen: true,
      title: `Remove ${name}?`,
      message: 'It will be unpaired from this phone. To use it again, scan its QR code. Files already transferred stay where they are.',
      confirmLabel: 'Remove',
      variant: 'danger',
      icon: 'unlink',
      onConfirm: async () => {
        setConfirmDialog(prev => ({ ...prev, isOpen: false }));
        await peerManager.remove(id);
        showToast(`Removed ${name}`, 'info');
      }
    });
  };

  // ---- sharing into the app (Android share sheet) --------------------------------------

  const discardShare = () => {
    const share = pendingShareRef.current;
    if (share) for (const f of share.files) releaseSharedUri(f.uri);
    setPendingShare(null);
    setIsDevicesOpen(false);
  };

  const deliverShare = (share: PendingShare, targets: PeerView[]) => {
    setPendingShare(null);
    if (share.text) sendTextTo(share.text, targets);
    for (const f of share.files) sendFile(f, 'normal', targets);
  };

  // With one device the share just goes. With several it asks first: something shared from another app
  // should never reach a device by surprise.
  const routeShare = (share: PendingShare) => {
    const now = peerManager.getSnapshot();
    const route = shareRoute(now.connected.length, now.targets.length);
    if (route === 'send') {
      deliverShare(share, now.targets);
      return;
    }
    setPendingShare(share); // 'wait': held until a device connects; 'ask': held until the user picks
    if (route === 'ask') {
      setDevicesMode('pick');
      setIsDevicesOpen(true);
    }
  };

  const handleIncomingShare = (data: { text?: string; files?: Array<{ name: string; size: number; mimeType: string; path?: string; uri?: string }> }) => {
    if (!data) return;
    const files = (data.files ?? []).filter(f => f.uri || f.path).map(f => new NativeSharedFile(f));
    const text = data.text?.trim() ? data.text : undefined;
    if (!text && files.length === 0) return;
    if (files.length > 0) showToast(`Receiving ${files.length} shared file${files.length > 1 ? 's' : ''}`, 'info');
    const existing = pendingShareRef.current;
    const share: PendingShare = existing
      ? { text: text ?? existing.text, files: [...existing.files, ...files] }
      : { text, files };
    if (peerManager.getSnapshot().connected.length === 0) showToast('Connect to a device to send this', 'info');
    routeShare(share);
  };

  const handleCopy = async (text: string) => {
    try {
      await Clipboard.write({ string: text });
      showToast('Copied to clipboard', 'success');
    } catch {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text)
          .then(() => showToast('Copied to clipboard', 'success'))
          .catch(() => showToast('Failed to copy', 'warning'));
      }
    }
  };

  // Everything a PC sends us, with the PC it came from.
  const onPeerMessage = (peerId: string, data: string) => {
    try {
      const msg: Message = JSON.parse(data);
      const peer = peerManager.getSnapshot().peers.find(p => p.id === peerId);
      if (!peer) return;
      const itemId = messageIdForPeer(peerId, msg.id);
      const severalPeers = peerManager.getSnapshot().peers.length > 1;

      if (msg.type === 'text') {
        const text = (msg.payload?.text || '').trim();
        if (!text) return;
        setMessages(prev => [...prev, {
          id: itemId,
          text: msg.payload.text,
          sender: 'other',
          timestamp: msg.timestamp * 1000,
          peerId,
          peerName: peer.name
        }]);
      } else if (msg.type === 'file_start') {
        const kind = getMediaKind(msg.payload.filename);
        const trust = peerManager.record(peerId)?.autoAccept !== false;
        const transferId = msg.payload.transferId;
        const filename = msg.payload.filename;
        const totalSize = msg.payload.totalSize;
        const totalChunks = msg.payload.totalChunks;
        const chunkSize = msg.payload.chunkSize;

        setMessages(prev => {
          // Check if we already have an existing transfer card for this file from this PC
          const existingIdx = prev.findIndex(m =>
            m.peerId === peerId && m.file && (
              m.file.transferId === transferId ||
              (m.file.filename === filename && m.file.totalSize === totalSize && m.file.status !== 'done')
            )
          );

          if (existingIdx !== -1) {
            const existing = prev[existingIdx];
            const cachedBytes = getCachedDownloadBytes(transferId, totalSize, totalChunks) ||
              (existing.file?.progress ? (existing.file.progress / 100) * totalSize : 0);
            const progressPct = totalSize > 0 ? (cachedBytes / totalSize) * 100 : 0;
            const effectiveProgress = Math.max(existing.file?.progress || 0, progressPct);

            const updatedFile = {
              ...existing.file,
              filename,
              transferId,
              totalSize,
              totalChunks,
              chunkSize,
              isDownloading: false,
              status: effectiveProgress > 0 ? 'interrupted' : (existing.file?.status || 'interrupted'),
              progress: effectiveProgress,
              isPendingApproval: !trust
            };

            const next: TransferItem[] = [...prev];
            next[existingIdx] = {
              ...existing,
              file: updatedFile,
              timestamp: msg.timestamp * 1000
            };

            if (trust && effectiveProgress > 0) {
              setTimeout(() => {
                latest.current?.handleDownload(existing.id, updatedFile, updatedFile.saveToDisk ?? true, peerId);
              }, 300);
            }
            return next;
          }

          // Brand new transfer
          const cachedBytes = getCachedDownloadBytes(transferId, totalSize, totalChunks);
          const initialProgress = totalSize > 0 ? (cachedBytes / totalSize) * 100 : 0;
          const fileInfo = {
            filename,
            transferId,
            totalSize,
            totalChunks,
            chunkSize,
            isDownloading: false,
            progress: initialProgress,
            mediaKind: kind,
            isPendingApproval: !trust
          };

          const next: TransferItem[] = [...prev, {
            id: itemId,
            file: fileInfo,
            sender: 'other' as const,
            timestamp: msg.timestamp * 1000,
            peerId,
            peerName: peer.name
          }];

          if (trust) {
            const shouldSaveToDisk = !(kind === 'image' && totalSize < 25 * 1024 * 1024);
            setTimeout(() => {
              latest.current?.handleDownload(itemId, fileInfo, shouldSaveToDisk, peerId);
            }, 100);
          }
          return next;
        });
      } else if (msg.type === 'clipboard') {
        if (localStorage.getItem('p2p_clipboard_sync') === 'false') return;
        const text = (msg.payload?.text || '').trim();
        if (!text) return;
        if (localStorage.getItem('p2p_sensitive_filter') !== 'false') {
          const check = isSensitiveClipboardText(text);
          if (check.sensitive) {
            showToast(`Skipped sensitive clipboard (${check.reason})`, 'warning');
            return;
          }
        }
        const fallback = () => {
          setMessages(prev => [...prev, {
            id: itemId,
            text: msg.payload.text,
            sender: 'other',
            timestamp: msg.timestamp * 1000,
            isClipboard: true,
            peerId,
            peerName: peer.name
          }]);
        };

        lastSyncedClipboardRef.current = msg.payload.text;
        const notifySynced = () =>
          showToast(severalPeers ? `Clipboard synced from ${peer.name}` : 'Clipboard auto-synced from PC', 'info');

        Clipboard.write({ string: msg.payload.text })
          .then(notifySynced)
          .catch(() => {
            if (navigator.clipboard?.writeText) {
              navigator.clipboard.writeText(msg.payload.text).then(notifySynced).catch(fallback);
            } else {
              fallback();
            }
          });
      }
    } catch (e) {
      console.error('Failed to parse message', e);
    }
  };

  // Start: handlers first, then connect the PCs that want to be connected (or pair, when opened from a QR link).
  useEffect(() => {
    peerManager.onMessage((peerId, data) => latest.current?.onPeerMessage(peerId, data));
    const offEvents = peerManager.onEvent(ev => latest.current?.onPeerEvent(ev));

    const hashParams = new URLSearchParams(window.location.hash.slice(1));
    const linkCode = hashParams.get('pair');
    const linkCert = hashParams.get('cert') || undefined;
    if (linkCode) {
      history.replaceState(null, '', window.location.pathname);
      pairAndConnect(window.location.host, linkCode, window.location.protocol.replace(':', ''), linkCert);
    } else {
      peerManager.start();
    }
    return offEvents;
  }, []);

  // Foreground resume: wake any PC that dropped, and share the clipboard with the focused one (FR 35, FR 36).
  // The clipboard goes to one device only, never to all of them.
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (document.visibilityState !== 'visible') return;
      peerManager.wakeAll();

      const target = peerManager.getSnapshot().focused;
      if (!target || target.status !== 'connected' || localStorage.getItem('p2p_clipboard_sync') === 'false') return;
      try {
        if (Capacitor.isNativePlatform()) {
          await new Promise(r => setTimeout(r, 220));
        }
        const { value } = await Clipboard.read();
        if (value && value.trim().length > 0 && value !== lastSyncedClipboardRef.current) {
          if (localStorage.getItem('p2p_sensitive_filter') !== 'false') {
            const check = isSensitiveClipboardText(value);
            if (check.sensitive) return;
          }
          lastSyncedClipboardRef.current = value;
          const msg = {
            type: 'clipboard',
            id: `msg-${Date.now()}`,
            timestamp: Math.floor(Date.now() / 1000),
            payload: { text: value }
          };
          peerManager.send(target.id, JSON.stringify(msg));
        }
      } catch {}
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  const handleDownload = async (id: string, file: NonNullable<TransferItem['file']>, saveToDisk = true, peerIdArg?: string) => {
    const itemRecord = messagesRef.current.find(m => m.id === id);
    if (itemRecord?.sender === 'me' && !file.blobUrl) {
      showToast('This file was sent from your device and is already on your phone.', 'info');
      return;
    }
    const peerId = peerIdArg ?? peerOfItem(id) ?? peerManager.getSnapshot().focused?.id;
    const api = apiFor(peerId);
    // 1. Fast path: if saving to disk and file was already downloaded (e.g. from Preview)
    if (saveToDisk && file.blobUrl) {
      try {
        const res = await fetch(file.blobUrl);
        if (res.ok) {
          const existingBlob = await res.blob();
          const targetLabel = downloadSubDir ? `Downloads/${downloadSubDir}` : 'Downloads';
          updateFile(id, { isDownloading: true, status: 'saving', progress: 0, savedBytes: 0, error: undefined });
          const saveRes = await saveToDeviceDownloads(
            existingBlob,
            file.filename,
            undefined,
            downloadSubDir,
            (written, total) => {
              const pct = total > 0 ? (written / total) * 100 : 100;
              updateFile(id, { progress: pct, savedBytes: written, status: 'saving' });
            }
          );
          if (saveRes.success) {
            showToast(`Saved ${file.filename} to ${targetLabel}`, 'success');
            updateFile(id, { isDownloading: false, status: 'done', progress: 100, savedBytes: undefined });
            return;
          }
        }
      } catch (err) {
        console.warn('Fast path save failed, falling back to fresh download:', err);
      }
    }

    if (!api) {
      updateFile(id, { isDownloading: false, status: 'error', error: 'This device was removed. Pair it again to download.' });
      return;
    }
    const existingCtrl = activeDownloads.get(id);
    if (existingCtrl) {
      existingCtrl.abort();
    }
    const abortCtrl = new AbortController();
    activeDownloads.set(id, abortCtrl);

    updateFile(id, { isDownloading: true, status: 'downloading', error: undefined, saveToDisk });

    try {
      const isSmallPreviewableOnNative =
        (file.mediaKind === 'code' && file.totalSize < 512 * 1024) ||
        ((file.mediaKind === 'audio' || file.mediaKind === 'pdf') && file.totalSize < 15 * 1024 * 1024);

      if (saveToDisk && Capacitor.isNativePlatform() && !isSmallPreviewableOnNative) {
        const targetLabel = downloadSubDir ? `Downloads/${downloadSubDir}` : 'Downloads';
        const res = await downloadDirectToDisk(api, {
          transferId: file.transferId,
          totalChunks: file.totalChunks,
          totalSize: file.totalSize
        }, {
          filename: file.filename,
          subDir: downloadSubDir
        }, (received, speed, eta) => {
          const pct = file.totalSize > 0 ? (received / file.totalSize) * 100 : 100;
          updateFile(id, { progress: pct, speed, eta, status: 'downloading' });
        }, abortCtrl.signal);

        activeDownloads.delete(id);
        if (res.success) {
          showToast(`Saved ${file.filename} to ${targetLabel}`, 'success');
        } else {
          showToast(`Downloaded ${file.filename}`, 'success');
        }
        updateFile(id, { isDownloading: false, status: 'done', progress: 100, savedBytes: undefined });
        return;
      }

      const blob = await downloadEncrypted(api, {
        transferId: file.transferId,
        totalChunks: file.totalChunks,
        totalSize: file.totalSize
      }, (received, speed, eta) => {
        const pct = file.totalSize > 0 ? (received / file.totalSize) * 100 : 100;
        updateFile(id, { progress: pct, speed, eta, status: 'downloading' });
      }, abortCtrl.signal);

      activeDownloads.delete(id);

      const url = URL.createObjectURL(blob);
      const isImg = file.mediaKind === 'image' || isImageFilename(file.filename);
      let thumb: string | undefined = undefined;
      let snippetData: { snippet: string; fullContent?: string; totalLines: number } | null = null;

      if (isImg) {
        thumb = await generateThumbnailDataUrl(blob);
      } else if (file.mediaKind === 'video') {
        thumb = await generateVideoThumbnailDataUrl(blob);
      } else if (file.mediaKind === 'code' && blob.size < 1024 * 1024) {
        snippetData = await extractTextSnippet(blob);
      }
      await saveBlobToCache(file.transferId, blob);

      const richFields = {
        blobUrl: url,
        thumbnailUrl: thumb,
        ...(snippetData
          ? {
              snippet: snippetData.snippet,
              fullContent: snippetData.fullContent,
              totalLines: snippetData.totalLines
            }
          : {})
      };

      if (saveToDisk) {
        const targetLabel = downloadSubDir ? `Downloads/${downloadSubDir}` : 'Downloads';
        updateFile(id, { isDownloading: true, status: 'saving', progress: 0, savedBytes: 0, ...richFields });
        const saveRes = await saveToDeviceDownloads(
          blob,
          file.filename,
          undefined,
          downloadSubDir,
          (written, total) => {
            const pct = total > 0 ? (written / total) * 100 : 100;
            updateFile(id, { progress: pct, savedBytes: written, status: 'saving' });
          }
        );
        if (saveRes.success) {
          showToast(`Saved ${file.filename} to ${targetLabel}`, 'success');
        } else {
          showToast(`Downloaded ${file.filename}`, 'success');
        }
        updateFile(id, { isDownloading: false, status: 'done', progress: 100, savedBytes: undefined, ...richFields });
      } else {
        updateFile(id, { isDownloading: false, progress: 100, status: 'done', ...richFields });
      }
    } catch (err) {
      activeDownloads.delete(id);
      const isAborted = abortCtrl.signal.aborted;
      const rawMsg = err instanceof Error ? err.message : 'Download failed';
      const isInterrupted = isAborted || !peerManager.connection(peerId ?? '')?.isConnected || rawMsg.includes('Failed to fetch') || rawMsg.includes('Network') || rawMsg.includes('Connection') || rawMsg.includes('timed out');
      updateFile(id, {
        isDownloading: false,
        status: isInterrupted ? 'interrupted' : 'error',
        speed: undefined,
        eta: undefined,
        error: isInterrupted ? 'Paused · tap Resume or wait for reconnect' : rawMsg
      });
      if (!isAborted && !isInterrupted) {
        showToast(`Failed to download ${file.filename}`, 'warning');
      } else if (!isAborted) {
        showToast(`Download paused: ${file.filename}`, 'warning');
      }
    }
  };

  // The hardware back button leaves the "add device" screen.
  useEffect(() => {
    if (!isAddingDevice) return;
    return backButtonManager.push(() => {
      setIsAddingDevice(false);
      setIsScanning(false);
      return true;
    });
  }, [isAddingDevice]);

  // QR scanner lifecycle
  useEffect(() => {
    if (!isScanning) return;
    setCameraError('');

    const unregisterBack = backButtonManager.push(() => {
      setIsScanning(false);
      return true;
    });

    let html5QrCode: Html5Qrcode | null = null;
    try {
      const qrEl = document.getElementById('qr-reader');
      if (!qrEl) {
        console.warn('qr-reader element not found in DOM');
        setIsScanning(false);
        setIsEditingIp(true);
        return;
      }

      html5QrCode = new Html5Qrcode('qr-reader');
      html5QrCode.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        (decodedText) => {
          html5QrCode?.stop().catch(() => { });
          setIsScanning(false);
          const link = parsePairingLink(decodedText);
          if (link.code) {
            pairAndConnect(link.host, link.code, link.scheme, link.cert);
          } else {
            pairAndConnect(link.host);
          }
        },
        () => { }
      ).catch(err => {
        console.error('Camera error', err);
        setCameraError(
          Capacitor.isNativePlatform()
            ? 'Camera permission was denied. Enable Camera access in Android App Settings, or connect via IP address below.'
            : 'Camera access was denied or unavailable. Allow camera permission in your browser, or connect via IP address below.'
        );
        setIsScanning(false);
        setIsEditingIp(true);
      });
    } catch (err) {
      console.error('Failed to init QR scanner', err);
      setIsScanning(false);
      setIsEditingIp(true);
    }

    return () => {
      unregisterBack();
      if (html5QrCode && html5QrCode.isScanning) {
        html5QrCode.stop().catch(() => { });
      }
    };
  }, [isScanning]);

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    let raw = address.trim().replace(/^https?:\/\//, '').split('/')[0];
    if (raw && !raw.includes(':')) {
      raw = `${raw}:8080`;
    }
    if (!raw || raw === 'localhost:8080' || raw === 'localhost' || raw.startsWith('127.0.0.1')) {
      if (Capacitor.isNativePlatform()) {
        setConnectError('Please enter your desktop LAN IP address (e.g. 192.168.1.15:8080) or tap "Scan QR Code".');
        return;
      }
    }
    if (!raw) return;
    setAddress(raw);
    // "Change IP" on the card of the one paired PC edits where to find it; anywhere else this adds a new device.
    const only = !isAddingDevice && snap.peers.length === 1 ? snap.peers[0] : null;
    if (only) {
      setAddress(raw);
      peerManager.updateAddress(only.id, raw);
      await connectPeer(only.id, raw);
      return;
    }
    await pairAndConnect(raw);
  };

  const openDevices = (mode: 'manage' | 'pick' = 'manage') => {
    setDevicesMode(mode);
    setIsDevicesOpen(true);
  };

  const closeDevices = () => {
    setIsDevicesOpen(false);
    if (devicesMode === 'pick' && pendingShareRef.current) {
      discardShare();
      showToast('Nothing was sent', 'info');
    }
  };

  /** Devices that can be switched on or off as recipients; at least tells the user why nothing was sent. */
  const requireTargets = (): PeerView[] | null => {
    const now = peerManager.getSnapshot();
    if (now.targets.length > 0) return now.targets;
    if (now.connected.length > 0) {
      showToast('Pick a device to send to', 'warning');
      openDevices('manage');
    } else {
      showToast('Connect to a device first', 'warning');
    }
    return null;
  };

  // One card for the message, however many devices get it; a device that dropped a moment ago is queued.
  const sendTextTo = (text: string, targets?: PeerView[]) => {
    const to = targets ?? requireTargets();
    if (!to || to.length === 0) return;
    const id = `msg-${Date.now()}`;
    const msg: Message = { version: 1, type: 'text', id, timestamp: Math.floor(Date.now() / 1000), payload: { text } };

    const sentTo: PeerView[] = [];
    const queuedFor: PeerView[] = [];
    for (const peer of to) {
      if (peerManager.send(peer.id, JSON.stringify(msg))) sentTo.push(peer);
      else queuedFor.push(peer);
    }
    if (queuedFor.length > 0) {
      setPendingOutbox(prev => {
        const next = { ...prev };
        for (const p of queuedFor) next[p.id] = [...(next[p.id] ?? []), msg];
        return next;
      });
    }
    setMessages(prev => [...prev, {
      id,
      text,
      sender: 'me',
      timestamp: Date.now(),
      isPending: sentTo.length === 0,
      peerId: to[0].id,
      peerName: describeTargets(to.map(p => p.name)),
      peerIds: to.map(p => p.id)
    }]);
    const summary = summarizeSend('Sent', sentTo.map(p => p.name), queuedFor.map(p => p.name));
    showToast(summary.text, summary.type);
  };

  const handleSendText = (text: string) => sendTextTo(text);

  const handleQuickSendClipboard = async () => {
    try {
      const { value } = await Clipboard.read();
      if (value && value.trim()) {
        handleSendText(value.trim());
        return;
      }
    } catch {}
    if (navigator.clipboard?.readText) {
      try {
        const val = await navigator.clipboard.readText();
        if (val && val.trim()) {
          handleSendText(val.trim());
          return;
        }
      } catch {}
    }
    showToast('Clipboard is empty or requires permission', 'warning');
  };

  const handleOpenFilePicker = (accept = '*/*', isFolder = false) => {
    if (isFolder && folderInputRef.current) {
      folderInputRef.current.click();
      return;
    }
    if (fileInputRef.current) {
      fileInputRef.current.accept = accept || '*/*';
      fileInputRef.current.click();
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    e.target.value = '';

    const targets = requireTargets();
    if (!targets) return;
    if (files.length > 1) {
      showToast(`Queueing ${files.length} files for upload`, 'info');
    }
    if (targets.length > 1) showToast(`Sending to ${describeTargets(targets.map(p => p.name))}`, 'info');
    files.forEach(f => sendFile(f, 'normal', targets));
  };

  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

  const handleDragEnter = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current++;
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.items)
      .filter(item => item.kind === 'file' && !item.webkitGetAsEntry?.()?.isDirectory)
      .map(item => item.getAsFile())
      .filter((file): file is File => file !== null);

    if (files.length > 0) {
      const targets = requireTargets();
      if (!targets) return;
      showToast(`Queueing ${files.length} dropped file${files.length > 1 ? 's' : ''}`, 'info');
      files.forEach(f => sendFile(f, 'normal', targets));
    }
  };

  const sendFile = async (file: File | UploadableFile, priority: UploadPriority = 'normal', targets?: PeerView[]) => {
    const to = targets ?? requireTargets();
    if (!to || to.length === 0) return;

    // The same file to several PCs is several transfers (each with its own progress and resume state).
    const baseId = transferIdFor(getDeviceId(), file);
    const fresh: PeerView[] = [];
    for (const peer of to) {
      if (!apiFor(peer.id)) continue; // removed a moment ago
      const running = uploads.get(`msg-${transferIdForPeer(baseId, peer.id)}`);
      if (running) uploadQueue.enqueue(running);
      else fresh.push(peer);
    }
    if (fresh.length === 0) return;

    // One shared content:// URI is released only when the last of its uploads finishes.
    const sharedUri = 'uri' in file && typeof (file as { uri?: unknown }).uri === 'string' ? (file as { uri: string }).uri : '';
    if (sharedUri) retainSharedUri(sharedUri, fresh.length);

    const kind = getMediaKind(file.name);
    let blobUrl: string | undefined = undefined;
    let thumbnailUrl: string | undefined = undefined;
    let snippet: string | undefined = undefined;
    let fullContent: string | undefined = undefined;
    let totalLines: number | undefined = undefined;

    // Builds ONE local preview (thumbnail, inline player, code snippet) for all recipients - including a file
    // shared in from Android's share sheet, which arrives as a NativeSharedFile rather than a real Blob/File.
    if (kind === 'image' && file.size < 50 * 1024 * 1024) {
      const blob = await materializeToBlob(file, 50 * 1024 * 1024);
      if (blob) {
        blobUrl = URL.createObjectURL(blob);
        thumbnailUrl = await generateThumbnailDataUrl(blob);
        saveBlobToCache(baseId, blob);
      }
    } else if ((kind === 'audio' || kind === 'video' || kind === 'pdf') && file.size < 120 * 1024 * 1024) {
      const blob = await materializeToBlob(file, 120 * 1024 * 1024);
      if (blob) {
        blobUrl = URL.createObjectURL(blob);
        if (kind === 'video') {
          thumbnailUrl = await generateVideoThumbnailDataUrl(blob);
        }
        saveBlobToCache(baseId, blob);
      }
    } else if (kind === 'code' && file.size < 1024 * 1024) {
      const blob = await materializeToBlob(file, 1024 * 1024);
      if (blob) {
        const extracted = await extractTextSnippet(blob);
        snippet = extracted.snippet;
        fullContent = extracted.fullContent;
        totalLines = extracted.totalLines;
      }
    }

    for (const peer of fresh) {
      const peerApi = apiFor(peer.id);
      if (!peerApi) {
        if (sharedUri) releaseSharedUri(sharedUri); // keep the count right for a PC that vanished meanwhile
        continue;
      }
      const transferId = transferIdForPeer(baseId, peer.id);
      const msgId = `msg-${transferId}`;

      // Persist pending upload metadata & blob for cold restart recovery (FR 19, NFR 16); one stored copy per file.
      savePendingUpload(transferId, msgId, file, priority, { peerId: peer.id, blobKey: baseId }).catch(() => {});

      const upload = new Upload(peerApi, file, transferId, p => {
        const progress = p.status === 'queued' ? {} : { progress: p.totalBytes ? (p.sentBytes / p.totalBytes) * 100 : 100 };
        updateFile(msgId, {
          status: p.status,
          priority: p.priority,
          speed: p.speed,
          eta: p.eta,
          error: p.error,
          ...progress
        });
        if (p.status === 'done' || p.status === 'canceled') {
          uploads.delete(msgId);
          uploadPeer.delete(msgId);
        }
      }, priority);

      uploads.set(msgId, upload);
      uploadPeer.set(msgId, peer.id);

      setMessages(prev => {
        const existing = prev.findIndex(m => m.id === msgId);
        const entry: TransferItem = {
          id: msgId,
          sender: 'me',
          timestamp: Date.now(),
          peerId: peer.id,
          peerName: peer.name,
          file: {
            filename: file.name,
            transferId,
            cacheKey: baseId,
            totalSize: file.size,
            totalChunks: upload.totalChunks,
            chunkSize: upload.chunkSize,
            status: upload.status,
            priority: upload.priority,
            blobUrl,
            thumbnailUrl,
            mediaKind: kind,
            snippet,
            fullContent,
            totalLines
          }
        };
        if (existing >= 0) {
          const next = [...prev];
          next[existing] = entry;
          return next;
        }
        return [...prev, entry];
      });

      uploadQueue.enqueue(upload);
    }
  };

  const handleTogglePriority = (id: string) => {
    const u = uploads.get(id);
    if (!u) return;
    const next = uploadQueue.toggleUploadPriority(u);
    updateFile(id, { priority: next });
    showToast(next === 'high' ? 'Prioritized to front of queue' : 'Priority reset to Normal', 'info');
  };

  const handleSavePreferences = async (prefs: {
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
  }) => {
    // 1. Save local settings
    if (prefs.deviceAlias) {
      setDeviceName(prefs.deviceAlias);
      localStorage.setItem('p2p_device_name', prefs.deviceAlias);
    }
    setDownloadSubDir(prefs.downloadSubDir);
    setDownloadSubDirState(prefs.downloadSubDir);

    setClientBandwidthLimitBps(prefs.bandwidthLimitBps);
    setBandwidthLimitState(prefs.bandwidthLimitBps);

    uploadQueue.setConcurrency(prefs.concurrencyMode);
    setConcurrencyModeState(prefs.concurrencyMode);

    setClipboardSyncEnabled(prefs.clipboardSyncEnabled);
    localStorage.setItem('p2p_clipboard_sync', prefs.clipboardSyncEnabled ? 'true' : 'false');

    setSensitiveFilterEnabled(prefs.sensitiveFilterEnabled);
    localStorage.setItem('p2p_sensitive_filter', prefs.sensitiveFilterEnabled ? 'true' : 'false');

    if (focused && prefs.pcAlias) peerManager.setServerName(focused.id, prefs.pcAlias);

    // 2. Sync with the focused desktop if connected
    const focusedApi = focused ? apiFor(focused.id) : undefined;
    if (focused && focused.status === 'connected' && focusedApi) {
      try {
        const updated = await focusedApi.updateSettings({
          bandwidthLimitBps: prefs.bandwidthLimitBps,
          maxConcurrency: prefs.concurrencyMode === 'auto' ? 0 : prefs.concurrencyMode,
          clipboardSyncEnabled: prefs.clipboardSyncEnabled,
          sensitiveFilterEnabled: prefs.sensitiveFilterEnabled,
          receiveDir: prefs.pcReceiveDir || undefined,
          pcAlias: prefs.pcAlias,
          deviceAlias: prefs.deviceAlias,
          contextMenuEnabled: prefs.contextMenuEnabled,
          autostartEnabled: prefs.autostartEnabled
        });
        setServerSettings(updated);
      } catch (err) {
        console.warn('Could not sync settings to desktop:', err);
      }
    }
    // The phone's own name is the same everywhere: tell every other connected PC too.
    if (prefs.deviceAlias) {
      for (const p of snap.connected) {
        if (p.id !== focused?.id) apiFor(p.id)?.updateDeviceAlias(prefs.deviceAlias).catch(() => {});
      }
    }

    showToast('Preferences saved', 'success');
  };

  const handleBatchPauseAll = () => {
    setIsBatchPaused(true);
    uploadQueue.pauseAll();
    showToast('Paused all transfers', 'info');
  };

  const handleBatchResumeAll = () => {
    setIsBatchPaused(false);
    uploadQueue.resumeInterrupted(uploads.values());
    showToast('Resumed transfers', 'info');
  };

  const handleBatchCancelAll = () => {
    uploadQueue.cancelAll();
    uploads.clear();
    uploadPeer.clear();
    setMessages(prev => prev.map(m => m.file?.status && ACTIVE_UPLOAD.includes(m.file.status)
      ? { ...m, file: { ...m.file, status: 'canceled', speed: 0 } }
      : m));
    showToast('Canceled all active transfers', 'info');
  };

  const requestBatchCancelAll = () => {
    const activeTotal = batchStats.activeCount + batchStats.pendingCount;
    setConfirmDialog({
      isOpen: true,
      title: 'Cancel All Transfers?',
      message: `Stop ${activeTotal > 0 ? activeTotal : 'all'} active or queued transfers? Any partially uploaded files will be stopped.`,
      confirmLabel: 'Cancel All',
      variant: 'danger',
      icon: 'warning',
      onConfirm: () => {
        setConfirmDialog(prev => ({ ...prev, isOpen: false }));
        handleBatchCancelAll();
      }
    });
  };

  // Filter messages
  const matchesPeer = (m: TransferItem) => peerFilter === 'all' || m.peerId === peerFilter || !!m.peerIds?.includes(peerFilter);
  const peerMessages = messages.filter(matchesPeer);
  const filteredMessages = peerMessages.filter(m => {
    if (filter === 'received') return m.sender === 'other';
    if (filter === 'sent') return m.sender === 'me';
    return true;
  });

  // Group filtered messages by date (sorted newest-first within each group)
  const groupedMessages = filteredMessages.reduce<Record<string, TransferItem[]>>((acc, msg) => {
    const group = getDateGroup(msg.timestamp);
    if (!acc[group]) acc[group] = [];
    acc[group].push(msg);
    return acc;
  }, {});
  for (const group of Object.keys(groupedMessages)) {
    groupedMessages[group].sort((a, b) => b.timestamp - a.timestamp);
  }

  const peerLabelFor = (m: TransferItem): string | undefined => {
    if (snap.peers.length < 2) return undefined;
    const nameOf = (id: string) => snap.peers.find(p => p.id === id)?.name;
    if (m.peerIds && m.peerIds.length > 1) return describeTargets(m.peerIds.map(id => nameOf(id) ?? 'device'));
    return (m.peerId ? nameOf(m.peerId) : undefined) ?? m.peerName;
  };

  // Everything callbacks outliving a render need, kept current.
  latest.current = { onPeerMessage, onPeerEvent, handleDownload, handleIncomingShare };

  /** What a pending share consists of, in words. */
  const describeShare = (share: PendingShare): string => {
    const parts: string[] = [];
    if (share.files.length > 0) parts.push(share.files.length === 1 ? '1 file' : `${share.files.length} files`);
    if (share.text) parts.push('text');
    return parts.join(' and ') || 'this';
  };

  // PCs on the Wi-Fi that are not paired yet.
  const nearbyDevices = discoveredDevices.filter(d => !(d.id && peerManager.has(d.id)) &&
    !snap.peers.some(p => p.address.replace(/^https?:\/\//, '').split('/')[0] === `${d.host}:${d.port}`));

  const dateGroupOrder: Array<'Today' | 'Yesterday' | 'Earlier this week' | 'Older'> = [
    'Today',
    'Yesterday',
    'Earlier this week',
    'Older'
  ];

  // ==========================================
  // VIEW: Connection & Setup Screen
  // ==========================================
  if (snap.connected.length === 0 || isAddingDevice) {
    return (
      <div className="app">
        <ToastContainer toasts={toasts} onDismiss={dismissToast} />

        {pendingShare && (
          <div className="pending-share" role="status">
            <span>Waiting to send {describeShare(pendingShare)}. Connect to a device.</span>
            <button type="button" className="icon-btn icon-btn-sm" onClick={discardShare} aria-label="Discard what was shared">
              <X size={16} />
            </button>
          </div>
        )}

        <ConnectionScreen
          mode={isAddingDevice ? 'add' : 'standby'}
          status={isPairing ? 'connecting' : status}
          address={address}
          setAddress={setAddress}
          peers={snap.peers}
          deviceName={deviceName}
          setDeviceName={setDeviceName}
          connectError={connectError}
          cameraError={cameraError}
          isScanning={isScanning}
          setIsScanning={setIsScanning}
          isEditingIp={isEditingIp}
          setIsEditingIp={setIsEditingIp}
          discoveredDevices={discoveredDevices}
          discoveryTip={discoveryTip}
          onConnectPeer={id => { void connectPeer(id); }}
          onDisconnectPeer={disconnectPeer}
          onToggleAutoAccept={(id, value) => peerManager.setAutoAccept(id, value)}
          onManualConnect={handleConnect}
          onConnectDiscovered={connectDiscovered}
          onOpenPreferences={() => setIsPrefsOpen(true)}
          onUnpairPeer={unpairPeer}
          onStartAddDevice={() => {
            setIsAddingDevice(true);
            setIsEditingIp(false);
            setConnectError('');
          }}
          pendingApproval={pendingApproval ? { host: pendingApproval.host, name: pendingApproval.name } : null}
          onCancelPairing={cancelPairing}
          connectingDiscoveredKey={connectingDiscoveredKey}
          onBack={() => {
            setIsAddingDevice(false);
            setIsScanning(false);
            setIsEditingIp(false);
            setConnectError('');
          }}
        />

        <PreferencesModal
          isOpen={isPrefsOpen}
          isConnected={false}
          theme={theme}
          onSetTheme={setTheme}
          deviceName={focused?.deviceName || deviceName}
          pcName={focused?.name || 'Desktop PC'}
          downloadSubDir={downloadSubDir}
          bandwidthLimitBps={bandwidthLimitBps}
          concurrencyMode={concurrencyMode}
          clipboardSyncEnabled={clipboardSyncEnabled}
          sensitiveFilterEnabled={sensitiveFilterEnabled}
          serverSettings={serverSettings}
          onClose={() => setIsPrefsOpen(false)}
          onSave={handleSavePreferences}
        />

        <ConfirmationDialog
          isOpen={confirmDialog.isOpen}
          title={confirmDialog.title}
          message={confirmDialog.message}
          confirmLabel={confirmDialog.confirmLabel}
          variant={confirmDialog.variant}
          icon={confirmDialog.icon}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog(prev => ({ ...prev, isOpen: false }))}
        />
      </div>
    );
  }


  // ==========================================
  // VIEW: Connected Transfer Activity Workspace
  // ==========================================
  return (
    <div
      className="app"
      onDragEnter={handleDragEnter}
      onDragOver={e => { if (hasFiles(e)) e.preventDefault(); }}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />

      {activeMedia && (
        <MediaViewer
          type={activeMedia.type}
          src={activeMedia.src}
          filename={activeMedia.filename}
          fileSize={activeMedia.fileSize}
          onClose={() => setActiveMedia(null)}
          onDownload={activeMedia.onDownload}
        />
      )}

      {isDragging && (
        <div className="drop-target-overlay">
          <UploadCloud size={36} />
          <span className="drop-primary-text">Drop to send</span>
          <span className="drop-sub-text">Encrypted, directly to your devices</span>
        </div>
      )}

      {/* Header: the active computer; tap to switch or manage devices */}
      <header className="top-bar workspace-bar">
        <button
          type="button"
          className="device-switcher"
          onClick={() => openDevices('manage')}
          aria-haspopup="dialog"
          aria-label={`${focused?.name || 'Desktop PC'}${snap.connected.length > 1 ? `, and ${snap.connected.length - 1} more` : ''}. Open devices.`}
        >
          <span className="device-switcher-text">
            <span className="device-switcher-name">
              <span className="truncate">{focused?.name || 'Desktop PC'}</span>
              {snap.connected.length > 1 && <span className="switcher-more">+{snap.connected.length - 1}</span>}
              <ChevronDown size={16} aria-hidden="true" />
            </span>
            <span className="device-switcher-sub">
              <span className="dot ok" />
              {snap.connected.length > 1 ? `${snap.connected.length} devices connected` : 'Connected'}
            </span>
          </span>
        </button>
        <button type="button" className="icon-btn" onClick={() => setIsPrefsOpen(true)} aria-label="Settings"><Settings size={20} /></button>
        <button type="button" className="icon-btn" onClick={() => setIsMenuOpen(true)} aria-label="More" aria-haspopup="dialog"><MoreVertical size={20} /></button>
      </header>

      {pendingApproval && (
        <div className="notice" role="status" style={{ alignItems: 'center' }}>
          <Loader2 size={18} className="spin notice-icon" style={{ marginTop: 0 }} />
          <div className="notice-main">
            <div className="notice-title">Waiting for {pendingApproval.name}</div>
            <div>Approve this phone on that computer.</div>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={cancelPairing}>Cancel</button>
        </div>
      )}

      {messages.length > 0 && (
        <nav className="filter-bar" aria-label="Filter transfers">
          <div className="segmented" role="group">
            {([['all', 'All'], ['received', 'Received'], ['sent', 'Sent']] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`segmented-item${filter === key ? ' active' : ''}`}
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>
          {snap.peers.length >= 2 && (
            <select className="peer-filter" value={peerFilter} onChange={e => setPeerFilter(e.target.value)} aria-label="Filter by device">
              <option value="all">All devices</option>
              {snap.peers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
        </nav>
      )}

      <main
        ref={scrollAreaRef}
        onScroll={e => {
          if (e.currentTarget.scrollTop <= 80 && hasUnseenActivity) setHasUnseenActivity(false);
        }}
        className={`scroll feed${filteredMessages.length === 0 ? ' is-empty' : ''}`}
      >
        {hasUnseenActivity && (
          <button
            type="button"
            className="new-activity-pill"
            onClick={() => {
              scrollAreaRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
              setHasUnseenActivity(false);
            }}
          >
            New transfer
          </button>
        )}

        {batchStats.totalCount > 1 && (
          <BatchProgress
            activeCount={batchStats.activeCount + batchStats.pendingCount}
            totalCount={batchStats.totalCount}
            sentBytes={batchStats.sentBytes}
            totalBytes={batchStats.totalBytes}
            speed={batchStats.speed}
            eta={batchStats.eta}
            isPaused={isBatchPaused}
            onPauseAll={handleBatchPauseAll}
            onResumeAll={handleBatchResumeAll}
            onCancelAll={requestBatchCancelAll}
          />
        )}

        {filteredMessages.length === 0 && (
          <StateView
            icon={<BrandLogo size={36} connected={true} />}
            title={messages.length === 0 ? 'Ready to send' : filter === 'all' ? 'Nothing matches' : `No ${filter} transfers`}
            body={messages.length === 0
              ? 'Send files, photos or text straight over your Wi‑Fi.'
              : peerFilter !== 'all'
                ? `No ${filter === 'all' ? '' : `${filter} `}transfers with ${nameOfPeer(peerFilter)} yet.`
                : `No ${filter} transfers yet.`}
          >
            {messages.length === 0 ? (
              <button type="button" className="btn btn-primary" onClick={() => handleOpenFilePicker()}>
                <UploadCloud size={16} /> Send files
              </button>
            ) : (
              <button type="button" className="btn btn-secondary" onClick={() => { setFilter('all'); setPeerFilter('all'); }}>
                Show everything
              </button>
            )}
          </StateView>
        )}

        {dateGroupOrder.map(group => {
          const groupItems = groupedMessages[group];
          if (!groupItems || groupItems.length === 0) return null;
          return (
            <section key={group} className="date-group">
              <h2 className="date-group-title">{group}</h2>
              <div className="date-group-items">
                {groupItems.map(item => (
                  <TransferCard
                    key={item.id}
                    item={item}
                    isDeleting={deletingIds.has(item.id)}
                    peerLabel={peerLabelFor(item)}
                    onCopy={handleCopy}
                    onDownload={handleDownload}
                    onDelete={handleDelete}
                    onOpenMedia={(media) => setActiveMedia(media)}
                    onAcceptApproval={(id, file) => {
                      updateFile(id, { isPendingApproval: false });
                      handleDownload(id, { ...file, isPendingApproval: false }, true);
                    }}
                    onAlwaysTrustApproval={(id, file) => {
                      const pid = peerOfItem(id);
                      if (pid) peerManager.setAutoAccept(pid, true);
                      updateFile(id, { isPendingApproval: false });
                      showToast(`${nameOfPeer(pid)} marked as trusted device`, 'success');
                      handleDownload(id, { ...file, isPendingApproval: false }, true);
                    }}
                    onRejectApproval={(id, file) => {
                      if (file?.transferId) {
                        const pid = peerOfItem(id);
                        apiFor(pid)?.call('/upload_cancel', { transferId: file.transferId, reason: 'rejected' }).catch(() => {});
                        if (pid) {
                          try {
                            peerManager.send(pid, JSON.stringify({
                              version: 1,
                              type: 'file_reject',
                              id: 'reject-' + file.transferId,
                              timestamp: Math.floor(Date.now() / 1000),
                              payload: {
                                transferId: file.transferId,
                                filename: file.filename,
                                reason: 'rejected'
                              }
                            }));
                          } catch {}
                        }
                      }
                      handleDelete(id, true);
                      showToast('Transfer rejected', 'info');
                    }}
                    onPauseUpload={(id) => {
                      const dlCtrl = activeDownloads.get(id);
                      if (dlCtrl) {
                        dlCtrl.abort();
                        activeDownloads.delete(id);
                        updateFile(id, { isDownloading: false, status: 'paused' });
                        showToast('Download paused', 'info');
                        return;
                      }
                      const u = uploads.get(id);
                      if (u) uploadQueue.pause(u);
                    }}
                    onResumeUpload={(id) => {
                      const item = messages.find(m => m.id === id);
                      if (item?.sender === 'other' && item?.file) {
                        handleDownload(id, item.file, item.file.saveToDisk ?? true);
                        return;
                      }
                      const u = uploads.get(id);
                      if (u) uploadQueue.enqueue(u);
                    }}
                    onCancelUpload={requestCancelTransfer}
                    onTogglePriority={handleTogglePriority}
                    onToast={showToast}
                  />
                ))}
              </div>
            </section>
          );
        })}

        {filteredMessages.length > 0 && (
          <div className="activity-scroll-spacer" aria-hidden="true" />
        )}
      </main>

      {/* Hidden Native File & Folder Inputs */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={handleFileUpload}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        {...({ webkitdirectory: '', directory: '' } as any)}
        style={{ display: 'none' }}
        onChange={handleFileUpload}
      />

      {/* 4. Purpose-Built Transfer Action Panel (with Category Filters & Quick-Send) */}
      <TransferActionPanel
        onOpenFilePicker={handleOpenFilePicker}
        onOpenSendText={() => setIsSendTextOpen(true)}
        onQuickSendClipboard={handleQuickSendClipboard}
        targetNames={snap.targets.map(p => p.name)}
        canPickTargets={snap.peers.length > 1}
        onPickTargets={() => openDevices('manage')}
      />

      {/* 5. Dedicated Text & Link Entry Modal */}
      <SendTextModal
        isOpen={isSendTextOpen}
        onClose={() => setIsSendTextOpen(false)}
        onSend={handleSendText}
        targetSummary={describeTargets(snap.targets.map(p => p.name))}
      />

      {/* 6. Transfer & Device Preferences Modal */}
      <PreferencesModal
        isOpen={isPrefsOpen}
        isConnected={true}
        theme={theme}
        onSetTheme={setTheme}
        deviceChoices={snap.connected.map(p => ({ id: p.id, name: p.name }))}
        selectedDeviceId={focused?.id ?? null}
        onSelectDevice={id => peerManager.setFocused(id)}
        deviceName={focused?.deviceName || deviceName}
        pcName={focused?.name || 'Desktop PC'}
        downloadSubDir={downloadSubDir}
        bandwidthLimitBps={bandwidthLimitBps}
        concurrencyMode={concurrencyMode}
        clipboardSyncEnabled={clipboardSyncEnabled}
        sensitiveFilterEnabled={sensitiveFilterEnabled}
        serverSettings={serverSettings}
        onClose={() => setIsPrefsOpen(false)}
        onSave={handleSavePreferences}
      />

      {/* 7. Devices: switch, connect several, choose who receives */}
      <DevicesSheet
        isOpen={isDevicesOpen}
        mode={devicesMode}
        pickSubject={pendingShare ? describeShare(pendingShare) : undefined}
        peers={snap.peers}
        focusedId={focused?.id}
        nearby={nearbyDevices}
        onClose={closeDevices}
        onSetFocused={id => {
          peerManager.setFocused(id);
          const p = snap.peers.find(peer => peer.id === id);
          showToast(`Active device: ${p?.name || 'Desktop'}`, 'info');
        }}
        onToggleTarget={(id, selected) => peerManager.setExcluded(id, !selected)}
        onConnect={id => { void connectPeer(id); }}
        onDisconnect={disconnectPeer}
        onRemove={id => {
          setIsDevicesOpen(false);
          unpairPeer(id);
        }}
        onToggleAutoAccept={(id, value) => peerManager.setAutoAccept(id, value)}
        onConnectNearby={d => {
          setIsDevicesOpen(false);
          void connectDiscovered(d);
        }}
        onAddDevice={() => {
          setIsDevicesOpen(false);
          setIsAddingDevice(true);
        }}
        onConfirmPick={() => {
          const share = pendingShareRef.current;
          setIsDevicesOpen(false);
          if (share) deliverShare(share, peerManager.getSnapshot().targets);
        }}
      />

      {/* Session menu */}
      <Sheet open={isMenuOpen} onClose={() => setIsMenuOpen(false)} title="Menu" flush>
        <ul className="rows">
          <li><button type="button" className="row" onClick={() => { setIsMenuOpen(false); openDevices('manage'); }}>
            <Laptop size={20} className="row-icon" />
            <span className="row-main"><span className="row-title">Devices</span>
              <span className="row-sub">{snap.connected.length} connected{snap.peers.length > snap.connected.length ? ` · ${snap.peers.length} saved` : ''}</span></span>
            <ChevronRight size={16} className="row-chevron" />
          </button></li>
          <li><button type="button" className="row" onClick={() => { setIsMenuOpen(false); setIsAddingDevice(true); }}>
            <Plus size={20} className="row-icon" />
            <span className="row-main"><span className="row-title">Add another device</span></span>
          </button></li>
          <li className="row">
            {focused?.autoAccept !== false ? <ShieldCheck size={20} className="row-icon" /> : <ShieldAlert size={20} className="row-icon" />}
            <span className="row-main">
              <span className="row-title">Accept files automatically</span>
              <span className="row-sub">{snap.peers.length > 1 && focused ? `From ${focused.name}` : 'Skip the approval prompt'}</span>
            </span>
            <Switch
              checked={focused?.autoAccept !== false}
              label="Accept files automatically"
              onChange={next => {
                if (!focused) return;
                peerManager.setAutoAccept(focused.id, next);
                showToast(next ? `Auto-accept from ${focused.name} on` : `Manual approval for ${focused.name}`, 'info');
              }}
            />
          </li>
          {messages.length > 0 && (
            <li><button type="button" className="row" onClick={() => {
              setIsMenuOpen(false);
              setConfirmDialog({
                isOpen: true,
                title: 'Clear transfer list?',
                message: 'Files already saved to Downloads stay where they are.',
                confirmLabel: 'Clear list',
                variant: 'danger',
                icon: 'trash',
                onConfirm: () => {
                  setConfirmDialog(prev => ({ ...prev, isOpen: false }));
                  const toClear = messagesRef.current.filter(m => !uploads.has(m.id));
                  toClear.forEach(item => {
                    purgeItemCache(item);
                    void deleteBlobFromCache(item.id);
                  });
                  setMessages(prev => prev.filter(m => uploads.has(m.id)));
                  showToast('Transfers cleared', 'info');
                },
              });
            }}>
              <Trash2 size={20} className="row-icon" />
              <span className="row-main"><span className="row-title">Clear transfer list</span></span>
            </button></li>
          )}
          <li><button type="button" className="row" onClick={() => { setIsMenuOpen(false); disconnectAll(); }}>
            <LogOut size={20} className="row-icon" />
            <span className="row-main"><span className="row-title">{snap.connected.length > 1 ? 'Disconnect all' : 'Disconnect'}</span></span>
          </button></li>
          <li><button type="button" className="row is-destructive" onClick={() => { setIsMenuOpen(false); if (focused) unpairPeer(focused.id); }}>
            <Unlink size={20} className="row-icon" />
            <span className="row-main"><span className="row-title">{snap.peers.length > 1 && focused ? `Forget ${focused.name}` : 'Forget this computer'}</span></span>
          </button></li>
        </ul>
      </Sheet>
      {/* 8. Native Confirmation Dialog */}
      <ConfirmationDialog
        isOpen={confirmDialog.isOpen}
        title={confirmDialog.title}
        message={confirmDialog.message}
        confirmLabel={confirmDialog.confirmLabel}
        variant={confirmDialog.variant}
        icon={confirmDialog.icon}
        onConfirm={confirmDialog.onConfirm}
        onCancel={() => setConfirmDialog(prev => ({ ...prev, isOpen: false }))}
      />
    </div>
  );
}
