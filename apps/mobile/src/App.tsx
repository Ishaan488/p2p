import React, { useState, useEffect, useRef } from 'react';
import { WebSocketTransport } from './lib/transport';
import { Message } from './lib/protocol';
import { HttpError, Pairing, ServerApi, isNetworkError, pairWithApproval, pairWithQr } from './lib/api';
import { randomHex } from './lib/crypto';
import { downloadEncrypted, saveToDeviceDownloads, downloadWithSystemManager } from './lib/downloads';
import { CHUNK_SIZE, Upload, UploadQueue, transferIdFor, BatchStats } from './lib/uploads';
import {
  QrCode, LogOut,
  Trash2, UploadCloud, Lock, Wifi,
  ShieldCheck, ShieldAlert, Unlink, MoreVertical,
  Sun, Moon, Monitor, ArrowDownUp, Laptop
} from 'lucide-react';
import { checkPendingShare, onSharedData } from './lib/shareTarget';
import { Capacitor } from '@capacitor/core';
import { Html5Qrcode } from 'html5-qrcode';
import { Clipboard } from '@capacitor/clipboard';
import { backButtonManager } from './lib/backButton';
import {
  getMediaKind, extractTextSnippet
} from './lib/telemetry';
import { saveBlobToCache, getBlobFromCache, generateThumbnailDataUrl } from './lib/storage';
import { startAutoDiscovery, DiscoveredDevice } from './lib/discovery';
import { ToastContainer, ToastMessage } from './components/Toast';
import { Lightbox } from './components/Lightbox';
import { BatchProgress } from './components/BatchProgress';
import { TransferCard, TransferItem } from './components/TransferCard';
import { TransferActionPanel } from './components/TransferActionPanel';
import { SendTextModal } from './components/SendTextModal';
import { ConfirmationDialog } from './components/ConfirmationDialog';

function isImageFilename(name: string): boolean {
  return /\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i.test(name);
}

const transport = new WebSocketTransport();
const api = new ServerApi();
const uploadQueue = new UploadQueue();
const uploads = new Map<string, Upload>(); // live uploads by message id

const defaultAddress = () => {
  if (Capacitor.isNativePlatform() || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return '';
  }
  return window.location.port ? window.location.host : `${window.location.hostname}:8080`;
};

const savedAddress = () => {
  const saved = localStorage.getItem('p2p_address');
  if (saved && saved !== 'localhost:8080' && saved !== 'localhost' && !saved.startsWith('127.0.0.1')) {
    return saved;
  }
  return defaultAddress();
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

const loadPairing = (): Pairing | null => {
  try {
    return JSON.parse(localStorage.getItem('p2p_pairing') || 'null');
  } catch {
    return null;
  }
};
api.pairing = loadPairing();

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

const describeFailure = (err: unknown, host: string) => {
  if (!isNetworkError(err)) return err instanceof Error ? err.message : 'Connection failed';
  const timedOut = err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError');
  return `${timedOut ? 'No answer from' : 'Could not reach'} the desktop at ${host}. Check that the address is correct, P2P Link is running on your PC, ` +
    'and both devices are connected to the same Wi-Fi (campus/public Wi-Fi often isolates devices; use a mobile hotspot if needed).';
};

const DIRECT_DOWNLOAD_ABOVE = 100 * 1024 * 1024;
const usesDirectDownload = (file: { totalSize: number }) =>
  file.totalSize > DIRECT_DOWNLOAD_ABOVE;

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

export default function App() {
  const [status, setStatus] = useState<'connected' | 'disconnected' | 'connecting' | 'error'>('connecting');
  const [address, setAddress] = useState(savedAddress);
  const [pairing, setPairing] = useState<Pairing | null>(() => api.pairing);
  const [deviceName, setDeviceName] = useState(() => localStorage.getItem('p2p_device_name') || guessDeviceName());
  const [connectError, setConnectError] = useState('');
  const [discoveredDevices, setDiscoveredDevices] = useState<DiscoveredDevice[]>([]);
  const [discoveryTip, setDiscoveryTip] = useState<string>('');
  const [isScanning, setIsScanning] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [isPcTrusted, setIsPcTrusted] = useState<boolean>(() => localStorage.getItem('p2p_trust_pc') !== 'false');

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
    return restored.map(m => m.file?.status && ACTIVE_UPLOAD.includes(m.file.status) && !uploads.has(m.id)
      ? { ...m, file: { ...m.file, status: 'interrupted', speed: 0 } }
      : m);
  });

  const [pendingOutbox, setPendingOutbox] = useState<Message[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('p2p_outbox') || '[]');
    } catch {
      return [];
    }
  });

  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [isDragging, setIsDragging] = useState(false);
  const [batchStats, setBatchStats] = useState<BatchStats>(() => uploadQueue.getStats());
  const [isBatchPaused, setIsBatchPaused] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const dragDepth = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [lightboxImage, setLightboxImage] = useState<{
    src: string;
    filename: string;
    fileSize?: number;
    onDownload?: () => void;
  } | null>(null);

  // Apply Theme
  useEffect(() => {
    localStorage.setItem('p2p_theme', theme);
    const applyTheme = () => {
      if (theme === 'system') {
        const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
      } else {
        document.documentElement.setAttribute('data-theme', theme);
      }
    };
    applyTheme();

    if (theme === 'system') {
      const media = window.matchMedia('(prefers-color-scheme: dark)');
      media.addEventListener('change', applyTheme);
      return () => media.removeEventListener('change', applyTheme);
    }
  }, [theme]);

  const showToast = (text: string, type: 'info' | 'success' | 'warning' = 'info') => {
    const id = `toast-${Date.now()}-${Math.random()}`;
    setToasts(prev => [...prev, { id, text, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 2800);
  };

  const dismissToast = (id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  // Auto-discovery
  useEffect(() => {
    if (status !== 'disconnected') return;
    const stop = startAutoDiscovery(
      device => {
        setDiscoveredDevices(prev => {
          if (prev.some(d => d.host === device.host && d.port === device.port)) return prev;
          return [...prev, device];
        });
      },
      tip => setDiscoveryTip(tip)
    );
    return stop;
  }, [status]);

  // Back button init
  useEffect(() => {
    backButtonManager.init(showToast);
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
    const toSave = messages.map(m => {
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
          const cached = await getBlobFromCache(m.file.transferId);
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

  // Flush offline outbox when connection is restored
  useEffect(() => {
    if (status === 'connected' && transport.isConnected()) {
      uploadQueue.resumeInterrupted(uploads.values());
      if (pendingOutbox.length > 0) {
        for (const msg of pendingOutbox) {
          transport.send(JSON.stringify(msg));
          setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, isPending: false } : m));
        }
        setPendingOutbox([]);
        showToast(`Delivered ${pendingOutbox.length} pending transfer(s)`, 'success');
      }
    }
  }, [status, pendingOutbox]);

  // Auto-reconnect when Wi-Fi recovers
  useEffect(() => {
    const handleOnline = () => {
      showToast('Network restored — reconnecting...', 'info');
      if (!transport.isConnected() && api.pairing) {
        connectTo(savedAddress()).catch(console.error);
      }
      uploadQueue.resumeInterrupted(uploads.values());
    };
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, []);

  // Android Share Target integration
  useEffect(() => {
    const handleShare = async (data: any) => {
      if (!data) return;
      if (data.text) {
        handleSendText(data.text);
      }
      if (data.files && data.files.length > 0) {
        showToast(`Receiving ${data.files.length} shared file(s)`, 'info');
        for (const f of data.files) {
          try {
            const fileUrl = Capacitor.convertFileSrc(f.path);
            const resp = await fetch(fileUrl);
            const blob = await resp.blob();
            const file = new File([blob], f.name, { type: f.mimeType });
            sendFile(file);
          } catch (e) {
            console.error('Failed to import shared file', e);
          }
        }
      }
    };

    checkPendingShare().then(data => {
      if (data) handleShare(data);
    });

    const cleanup = onSharedData(data => {
      handleShare(data);
    });

    return () => {
      cleanup.then(unsub => unsub());
    };
  }, []);

  const cancelUpload = (id: string, transferId: string) => {
    const upload = uploads.get(id);
    if (upload) {
      uploadQueue.cancel(upload);
    } else {
      api.call('/upload_cancel', { transferId }).catch(() => { });
      updateFile(id, { status: 'canceled' });
    }
  };

  const handleDelete = (id: string) => {
    const file = messages.find(m => m.id === id)?.file;
    if (file?.status && file.status !== 'done' && file.status !== 'canceled') {
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
    }, 250);
  };

  const savePairing = (next: Pairing | null) => {
    api.pairing = next;
    setPairing(next);
    if (next) localStorage.setItem('p2p_pairing', JSON.stringify(next));
    else localStorage.removeItem('p2p_pairing');
  };

  const connectTo = async (target: string) => {
    api.host = target.split('/')[0];
    setConnectError('');
    if (!api.pairing) {
      setStatus('disconnected');
      throw new Error('Not paired');
    }
    setStatus('connecting');
    let socket: Awaited<ReturnType<ServerApi['openSocket']>>;
    try {
      socket = await api.openSocket();
    } catch (err) {
      if (err instanceof HttpError && err.code === 'not_paired') {
        savePairing(null);
        setConnectError('Device is no longer paired with this PC. Scan the desktop QR code to pair again.');
        setStatus('disconnected');
      } else {
        setStatus('error');
        setConnectError(describeFailure(err, api.host));
      }
      throw err;
    }
    return transport.connect(socket.url, socket.cipher);
  };

  const pairAndConnect = async (host: string, secret?: string, scheme = 'http', cert?: string) => {
    setConnectError('');
    setStatus('connecting');
    setAddress(host);
    try {
      const name = deviceName.trim() || guessDeviceName();
      localStorage.setItem('p2p_device_name', name);
      api.scheme = (scheme === 'https' ? 'https' : 'http');
      savePairing(secret
        ? await pairWithQr(host, secret, getDeviceId(), name, scheme, cert)
        : await pairWithApproval(host, getDeviceId(), name, scheme));
    } catch (err) {
      setStatus('disconnected');
      setConnectError(describeFailure(err, host));
      return;
    }
    localStorage.setItem('p2p_address', host);
    localStorage.setItem('p2p_auto_connect', 'true');
    await connectTo(host).catch(console.error);
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

  // Wire transport events
  useEffect(() => {
    transport.onStatusChange(setStatus);
    transport.onMessage((data) => {
      try {
        const msg: Message = JSON.parse(data);
        if (msg.type === 'text') {
          const text = (msg.payload?.text || '').trim();
          if (!text) return;
          setMessages(prev => [...prev, {
            id: msg.id,
            text: msg.payload.text,
            sender: 'other',
            timestamp: msg.timestamp * 1000
          }]);
        } else if (msg.type === 'file_start') {
          const kind = getMediaKind(msg.payload.filename);
          const trust = localStorage.getItem('p2p_trust_pc') !== 'false';
          const fileInfo = {
            filename: msg.payload.filename,
            transferId: msg.payload.transferId,
            totalSize: msg.payload.totalSize,
            totalChunks: msg.payload.totalChunks,
            chunkSize: msg.payload.chunkSize,
            isDownloading: false,
            progress: 0,
            mediaKind: kind,
            isPendingApproval: !trust
          };
          setMessages(prev => [...prev, {
            id: msg.id,
            file: fileInfo,
            sender: 'other',
            timestamp: msg.timestamp * 1000
          }]);

          // Automatically download small images (< 25 MB) if PC is trusted
          if (trust && kind === 'image' && msg.payload.totalSize < 25 * 1024 * 1024) {
            setTimeout(() => {
              handleDownload(msg.id, fileInfo, false);
            }, 100);
          }
        } else if (msg.type === 'clipboard') {
          const text = (msg.payload?.text || '').trim();
          if (!text) return;
          const fallback = () => {
            setMessages(prev => [...prev, {
              id: msg.id,
              text: msg.payload.text,
              sender: 'other',
              timestamp: msg.timestamp * 1000,
              isClipboard: true
            }]);
          };

          try {
            if (navigator.clipboard?.writeText) {
              navigator.clipboard.writeText(msg.payload.text)
                .then(() => showToast('Clipboard auto-synced from PC', 'info'))
                .catch(fallback);
            } else {
              fallback();
            }
          } catch {
            fallback();
          }
        }
      } catch (e) {
        console.error('Failed to parse message', e);
      }
    });

    const hashParams = new URLSearchParams(window.location.hash.slice(1));
    const linkCode = hashParams.get('pair');
    const linkCert = hashParams.get('cert') || undefined;
    if (linkCode) {
      history.replaceState(null, '', window.location.pathname);
      pairAndConnect(window.location.host, linkCode, window.location.protocol.replace(':', ''), linkCert);
    } else if (api.pairing && localStorage.getItem('p2p_auto_connect') !== 'false') {
      connectTo(savedAddress()).catch(console.error);
    } else {
      setStatus('disconnected');
    }

    return () => transport.disconnect();
  }, []);

  // Foreground resume auto-reconnect
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'visible') {
        let isReady = transport.isConnected();
        if (!isReady && api.pairing && localStorage.getItem('p2p_auto_connect') !== 'false') {
          try {
            await connectTo(savedAddress());
            isReady = true;
          } catch (e) {
            console.error(e);
          }
        }

        if (isReady) {
          try {
            const { value } = await Clipboard.read();
            if (value && value.trim().length > 0) {
              const msg = {
                type: 'clipboard',
                id: `msg-${Date.now()}`,
                timestamp: Math.floor(Date.now() / 1000),
                payload: { text: value }
              };
              transport.send(JSON.stringify(msg));
            }
          } catch {}
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  const handleDownload = async (id: string, file: NonNullable<TransferItem['file']>, saveToDisk = true) => {
    updateFile(id, { isDownloading: true, progress: 0, error: undefined });

    if (saveToDisk && usesDirectDownload(file)) {
      try {
        const url = await api.directDownloadUrl(file.transferId);
        const enqueued = await downloadWithSystemManager(url, file.filename);
        if (enqueued) {
          updateFile(id, { isDownloading: false, progress: 100 });
          showToast(`Direct download queued in system manager: ${file.filename}`, 'success');
          return;
        }
      } catch (err) {
        console.warn('System download manager failed, falling back to encrypted chunk download', err);
      }
    }

    try {
      const blob = await downloadEncrypted(api, {
        transferId: file.transferId,
        totalChunks: file.totalChunks,
        totalSize: file.totalSize
      }, (received, speed, eta) => {
        const pct = file.totalSize > 0 ? (received / file.totalSize) * 100 : 100;
        updateFile(id, { progress: pct, speed, eta });
      });

      const url = URL.createObjectURL(blob);
      const isImg = file.mediaKind === 'image' || isImageFilename(file.filename);
      let thumb: string | undefined = undefined;

      if (isImg) {
        thumb = await generateThumbnailDataUrl(blob);
      }
      await saveBlobToCache(file.transferId, blob);
      updateFile(id, { isDownloading: false, progress: 100, blobUrl: url, thumbnailUrl: thumb });

      if (saveToDisk) {
        await saveToDeviceDownloads(blob, file.filename);
        showToast(`Saved ${file.filename} to Downloads`, 'success');
      }
    } catch (err) {
      updateFile(id, {
        isDownloading: false,
        error: err instanceof Error ? err.message : 'Download failed'
      });
      showToast(`Failed to download ${file.filename}`, 'warning');
    }
  };

  // QR scanner lifecycle
  useEffect(() => {
    if (!isScanning) return;
    setCameraError('');

    const unregisterBack = backButtonManager.push(() => {
      setIsScanning(false);
      return true;
    });

    const html5QrCode = new Html5Qrcode('qr-reader');
    html5QrCode.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 250, height: 250 } },
      (decodedText) => {
        html5QrCode.stop().catch(() => { });
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
      setCameraError('Camera access denied or unsupported. Browser may require HTTPS.');
      setIsScanning(false);
    });

    return () => {
      unregisterBack();
      if (html5QrCode.isScanning) {
        html5QrCode.stop().catch(() => { });
      }
    };
  }, [isScanning]);

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    const raw = address.trim().replace(/^https?:\/\//, '').split('/')[0];
    if (!raw || raw === 'localhost:8080' || raw === 'localhost' || raw.startsWith('127.0.0.1')) {
      if (Capacitor.isNativePlatform()) {
        setConnectError('Please enter your desktop LAN IP address (e.g. 192.168.1.15:8080) or tap "Scan QR Code".');
        return;
      }
    }
    const host = raw;
    if (!host) return;
    if (!pairing) {
      await pairAndConnect(host);
      return;
    }
    setAddress(host);
    localStorage.setItem('p2p_address', host);
    localStorage.setItem('p2p_auto_connect', 'true');
    await connectTo(host).catch(console.error);
  };

  const handleDisconnect = () => {
    localStorage.setItem('p2p_auto_connect', 'false');
    transport.disconnect();
    setStatus('disconnected');
    showToast('Disconnected from desktop', 'info');
  };

  const handleSendText = (text: string) => {
    const id = `msg-${Date.now()}`;
    const timestamp = Math.floor(Date.now() / 1000);

    const msg: Message = {
      version: 1,
      type: 'text',
      id,
      timestamp,
      payload: { text }
    };

    const isConnected = status === 'connected' && transport.isConnected();
    if (isConnected) {
      transport.send(JSON.stringify(msg));
    } else {
      setPendingOutbox(prev => [...prev, msg]);
      showToast('Offline — queued to send on connect', 'info');
    }

    setMessages(prev => [...prev, {
      id,
      text,
      sender: 'me',
      timestamp: Date.now(),
      isPending: !isConnected
    }]);
    showToast('Sent to desktop', 'success');
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    e.target.value = '';

    if (!transport.isConnected()) {
      setStatus('connecting');
      try {
        localStorage.setItem('p2p_auto_connect', 'true');
        await connectTo(savedAddress());
      } catch (err) {
        console.error('Failed to reconnect before upload', err);
        return;
      }
    }

    if (files.length > 1) {
      showToast(`Queueing ${files.length} files for upload`, 'info');
    }
    files.forEach(sendFile);
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
      showToast(`Queueing ${files.length} dropped file${files.length > 1 ? 's' : ''}`, 'info');
      files.forEach(sendFile);
    }
  };

  const sendFile = async (file: File) => {
    const transferId = transferIdFor(getDeviceId(), file);
    const msgId = `msg-${transferId}`;

    const running = uploads.get(msgId);
    if (running) {
      uploadQueue.enqueue(running);
      return;
    }

    const kind = getMediaKind(file.name);
    let blobUrl: string | undefined = undefined;
    let thumbnailUrl: string | undefined = undefined;
    let snippet: string | undefined = undefined;
    let fullContent: string | undefined = undefined;
    let totalLines: number | undefined = undefined;

    if (kind === 'image' && file.size < 50 * 1024 * 1024) {
      blobUrl = URL.createObjectURL(file);
      thumbnailUrl = await generateThumbnailDataUrl(file);
      saveBlobToCache(transferId, file);
    } else if ((kind === 'audio' || kind === 'video' || kind === 'pdf') && file.size < 120 * 1024 * 1024) {
      blobUrl = URL.createObjectURL(file);
      saveBlobToCache(transferId, file);
    } else if (kind === 'code') {
      const extracted = await extractTextSnippet(file);
      snippet = extracted.snippet;
      fullContent = extracted.fullContent;
      totalLines = extracted.totalLines;
    }

    const upload = new Upload(api, file, transferId, p => {
      const progress = p.status === 'queued' ? {} : { progress: p.totalBytes ? (p.sentBytes / p.totalBytes) * 100 : 100 };
      updateFile(msgId, {
        status: p.status,
        speed: p.speed,
        eta: p.eta,
        error: p.error,
        ...progress
      });
      if (p.status === 'done' || p.status === 'canceled' || p.status === 'error') {
        uploads.delete(msgId);
      }
    });

    uploads.set(msgId, upload);

    setMessages(prev => {
      const existing = prev.findIndex(m => m.id === msgId);
      const entry: TransferItem = {
        id: msgId,
        sender: 'me',
        timestamp: Date.now(),
        file: {
          filename: file.name,
          transferId,
          totalSize: file.size,
          totalChunks: upload.totalChunks,
          chunkSize: CHUNK_SIZE,
          status: upload.status,
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
    setMessages(prev => prev.map(m => m.file?.status && ACTIVE_UPLOAD.includes(m.file.status)
      ? { ...m, file: { ...m.file, status: 'canceled', speed: 0 } }
      : m));
    showToast('Canceled all active transfers', 'info');
  };

  // Filter messages
  const filteredMessages = messages.filter(m => {
    if (filter === 'received') return m.sender === 'other';
    if (filter === 'sent') return m.sender === 'me';
    return true;
  });

  // Group filtered messages by date
  const groupedMessages = filteredMessages.reduce<Record<string, TransferItem[]>>((acc, msg) => {
    const group = getDateGroup(msg.timestamp);
    if (!acc[group]) acc[group] = [];
    acc[group].push(msg);
    return acc;
  }, {});

  const dateGroupOrder: Array<'Today' | 'Yesterday' | 'Earlier this week' | 'Older'> = [
    'Today',
    'Yesterday',
    'Earlier this week',
    'Older'
  ];

  // ==========================================
  // VIEW: Connection & Setup Screen
  // ==========================================
  if (status !== 'connected') {
    return (
      <div className="app-container">
        <ToastContainer toasts={toasts} onDismiss={dismissToast} />

        {/* Minimalist Compact Header */}
        <header className="app-header">
          <div className="header-brand">
            <div className="brand-icon-box">
              <ArrowDownUp size={16} />
            </div>
            <div className="brand-text-box">
              <span className="brand-name">P2P Link</span>
              <span className="brand-caption">Local Transfer</span>
            </div>
          </div>

          <div className="header-status-pill">
            <span className={`status-dot ${status}`} />
            <span className="status-label">
              {status === 'connecting' ? 'Connecting...' : status === 'error' ? 'Failed' : 'Standby'}
            </span>
          </div>
        </header>

        {/* Connection Setup Content */}
        <main className="connection-screen">
          <div className="connection-card">
            <div className="connection-hero-icon">
              <Laptop size={28} />
            </div>

            {isScanning ? (
              <div className="scanner-container">
                <h2 className="scanner-title">Scan Desktop QR Code</h2>
                <p className="scanner-subtitle">
                  Point camera at the QR code displayed in your PC terminal
                </p>
                <div id="qr-reader" className="qr-viewport" />
                <button
                  type="button"
                  onClick={() => setIsScanning(false)}
                  className="btn btn-secondary full-width"
                >
                  Cancel Scanner
                </button>
              </div>
            ) : (
              <>
                <h2 className="connection-title">Connect to Desktop</h2>
                <p className="connection-subtitle">
                  {pairing ? (
                    <>
                      Linked with <strong className="peer-highlight">{pairing.serverName || 'Desktop PC'}</strong> as <strong>{pairing.deviceName}</strong>
                    </>
                  ) : (
                    'Scan the QR code shown in your PC terminal to pair instantly over local Wi-Fi.'
                  )}
                </p>

                {cameraError && (
                  <div className="connection-alert error">
                    {cameraError}
                  </div>
                )}

                {connectError && !cameraError && (
                  <div className="connection-alert error">
                    {connectError}
                  </div>
                )}

                {/* Primary QR Action */}
                <button
                  type="button"
                  onClick={() => setIsScanning(true)}
                  className="btn btn-primary btn-large full-width"
                >
                  <QrCode size={18} />
                  <span>{pairing ? 'Scan QR to Reconnect' : 'Scan QR Code'}</span>
                </button>

                {/* Discovered Devices on Wi-Fi */}
                {discoveredDevices.length > 0 && (
                  <div className="discovered-block">
                    <div className="section-label">
                      <Wifi size={13} />
                      <span>DISCOVERED ON LOCAL NETWORK</span>
                    </div>
                    <div className="discovered-list">
                      {discoveredDevices.map(d => (
                        <div key={`${d.host}:${d.port}`} className="discovered-card">
                          <div className="discovered-meta">
                            <span className="discovered-name">{d.serverName || d.name}</span>
                            <span className="discovered-address">{d.host}:{d.port} {d.scheme === 'https' ? '• TLS' : ''}</span>
                          </div>
                          <button
                            type="button"
                            className="btn btn-secondary btn-compact"
                            onClick={() => {
                              const targetHost = `${d.host}:${d.port}`;
                              setAddress(targetHost);
                              if (pairing) {
                                localStorage.setItem('p2p_address', targetHost);
                                localStorage.setItem('p2p_auto_connect', 'true');
                                connectTo(targetHost).catch(console.error);
                              } else {
                                pairAndConnect(targetHost, undefined, d.scheme, d.cert);
                              }
                            }}
                          >
                            Connect
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {discoveryTip && discoveredDevices.length === 0 && (
                  <div className="discovery-tip-box">
                    <span>{discoveryTip}</span>
                  </div>
                )}

                {/* Manual Address Section */}
                <div className="section-divider">
                  <span>OR MANUAL ADDRESS</span>
                </div>

                <form onSubmit={handleConnect} className="manual-form">
                  <div className="form-field">
                    <label className="form-label">Desktop IP & Port</label>
                    <input
                      type="text"
                      className="form-input form-input-mono"
                      value={address}
                      onChange={e => setAddress(e.target.value)}
                      placeholder="e.g. 192.168.1.15:8080"
                    />
                  </div>

                  {!pairing && (
                    <div className="form-field">
                      <label className="form-label">Device Name</label>
                      <input
                        type="text"
                        className="form-input"
                        value={deviceName}
                        onChange={e => setDeviceName(e.target.value)}
                        maxLength={40}
                      />
                    </div>
                  )}

                  <button
                    type="submit"
                    className="btn btn-secondary full-width"
                    disabled={status === 'connecting'}
                  >
                    {status === 'connecting'
                      ? (pairing ? 'Connecting...' : 'Awaiting PC approval...')
                      : !pairing
                      ? 'Pair & Connect'
                      : 'Connect via IP'}
                  </button>

                  {pairing && (
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmDialog({
                          isOpen: true,
                          title: 'Forget This Desktop PC?',
                          message: 'This device will be unpaired and keys revoked. You will need to scan the desktop QR code to pair again.',
                          confirmLabel: 'Forget & Unpair',
                          variant: 'danger',
                          icon: 'unlink',
                          onConfirm: async () => {
                            setConfirmDialog(prev => ({ ...prev, isOpen: false }));
                            try {
                              await api.unpair();
                            } catch {}
                            savePairing(null);
                            showToast('Device unpaired', 'info');
                          }
                        });
                      }}
                      className="forget-device-btn"
                    >
                      <Unlink size={13} />
                      <span>Forget This PC</span>
                    </button>
                  )}
                </form>
              </>
            )}
          </div>
        </main>

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
      className="app-container"
      onDragEnter={handleDragEnter}
      onDragOver={e => { if (hasFiles(e)) e.preventDefault(); }}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />

      {/* Lightbox Image Preview */}
      {lightboxImage && (
        <Lightbox
          src={lightboxImage.src}
          filename={lightboxImage.filename}
          fileSize={lightboxImage.fileSize}
          onClose={() => setLightboxImage(null)}
          onDownload={lightboxImage.onDownload}
        />
      )}

      {/* Full-Window Drag & Drop Overlay */}
      {isDragging && (
        <div className="drop-target-overlay">
          <UploadCloud size={40} className="drop-icon" />
          <span className="drop-primary-text">Drop files to transfer</span>
          <span className="drop-sub-text">Direct end-to-end encrypted transfer</span>
        </div>
      )}

      {/* 1. Polished Header */}
      <header className="app-header">
        <div className="header-brand">
          <div className="brand-icon-box connected">
            <ArrowDownUp size={16} />
          </div>
          <div className="brand-text-box">
            <div className="brand-title-row">
              <span className="brand-name">P2P Link</span>
              <span className="security-badge" title="End-to-End Encrypted">
                <Lock size={10} />
                <span>E2EE</span>
              </span>
            </div>
            <div className="brand-peer-row">
              <span className="peer-live-dot" />
              <span className="peer-name">{pairing?.serverName || 'Desktop PC'}</span>
            </div>
          </div>
        </div>

        <div className="header-actions-box">
          <button
            type="button"
            onClick={() => setIsMenuOpen(o => !o)}
            className="header-action-btn"
            title="Menu & Options"
            aria-label="Menu"
          >
            <MoreVertical size={18} />
          </button>

          {isMenuOpen && (
            <>
              <div className="menu-scrim" onClick={() => setIsMenuOpen(false)} />
              <div className="overflow-menu-dropdown">
                {/* Connection Section */}
                <div className="menu-group-header">CONNECTION</div>
                <button
                  type="button"
                  className="menu-item"
                  onClick={() => {
                    setIsMenuOpen(false);
                    handleDisconnect();
                  }}
                >
                  <LogOut size={15} />
                  <span>Disconnect</span>
                </button>

                {/* Transfer Preferences */}
                <div className="menu-group-header">PREFERENCES</div>
                <button
                  type="button"
                  className="menu-item"
                  onClick={() => {
                    const next = !isPcTrusted;
                    setIsPcTrusted(next);
                    localStorage.setItem('p2p_trust_pc', next ? 'true' : 'false');
                    showToast(next ? 'Auto-accept enabled' : 'Manual approval required', 'info');
                    setIsMenuOpen(false);
                  }}
                >
                  {isPcTrusted ? <ShieldCheck size={15} color="var(--success)" /> : <ShieldAlert size={15} />}
                  <span>{isPcTrusted ? 'Auto-Accept: Enabled' : 'Auto-Accept: Disabled'}</span>
                </button>

                {/* Appearance */}
                <div className="menu-group-header">APPEARANCE</div>
                <div className="theme-toggle-row">
                  <button
                    type="button"
                    className={`theme-toggle-btn ${theme === 'light' ? 'active' : ''}`}
                    onClick={() => setTheme('light')}
                    title="Light Theme"
                  >
                    <Sun size={14} />
                    <span>Light</span>
                  </button>
                  <button
                    type="button"
                    className={`theme-toggle-btn ${theme === 'dark' ? 'active' : ''}`}
                    onClick={() => setTheme('dark')}
                    title="Dark Theme"
                  >
                    <Moon size={14} />
                    <span>Dark</span>
                  </button>
                  <button
                    type="button"
                    className={`theme-toggle-btn ${theme === 'system' ? 'active' : ''}`}
                    onClick={() => setTheme('system')}
                    title="Match System"
                  >
                    <Monitor size={14} />
                    <span>System</span>
                  </button>
                </div>

                {/* History Section */}
                <div className="menu-group-header">HISTORY</div>
                <button
                  type="button"
                  className="menu-item"
                  onClick={() => {
                    setIsMenuOpen(false);
                    setConfirmDialog({
                      isOpen: true,
                      title: 'Clear Transfer History?',
                      message: 'This removes transfer records on this device. Files saved in Downloads will not be deleted.',
                      confirmLabel: 'Clear History',
                      variant: 'danger',
                      icon: 'trash',
                      onConfirm: () => {
                        setConfirmDialog(prev => ({ ...prev, isOpen: false }));
                        setMessages(prev => prev.filter(m => uploads.has(m.id)));
                        showToast('Transfer history cleared', 'info');
                      }
                    });
                  }}
                >
                  <Trash2 size={15} />
                  <span>Clear History</span>
                </button>

                <div className="menu-separator" />

                {/* Device Management */}
                <button
                  type="button"
                  className="menu-item menu-item-danger"
                  onClick={() => {
                    setIsMenuOpen(false);
                    setConfirmDialog({
                      isOpen: true,
                      title: 'Forget This Desktop PC?',
                      message: 'This device will be unpaired and keys revoked. You will need to scan the desktop QR code to pair again.',
                      confirmLabel: 'Forget & Unpair',
                      variant: 'danger',
                      icon: 'unlink',
                      onConfirm: async () => {
                        setConfirmDialog(prev => ({ ...prev, isOpen: false }));
                        try {
                          await api.unpair();
                        } catch {}
                        savePairing(null);
                        transport.disconnect();
                        setStatus('disconnected');
                        showToast('Device forgotten and unpaired', 'info');
                      }
                    });
                  }}
                >
                  <Unlink size={15} />
                  <span>Forget This PC</span>
                </button>
              </div>
            </>
          )}
        </div>
      </header>

      {/* 2. Sub-Header Toolbar: Transfer History Title & Filter Segment */}
      <div className="workspace-sub-header">
        <div className="sub-header-title-row">
          <h1 className="screen-heading">Transfer history</h1>
          <span className="transfer-count-badge">
            {messages.length} {messages.length === 1 ? 'item' : 'items'}
          </span>
        </div>

        {/* Segmented Filter Control */}
        <div className="segmented-filter-bar">
          <button
            type="button"
            className={`filter-segment-btn ${filter === 'all' ? 'active' : ''}`}
            onClick={() => setFilter('all')}
          >
            All
          </button>
          <button
            type="button"
            className={`filter-segment-btn ${filter === 'received' ? 'active' : ''}`}
            onClick={() => setFilter('received')}
          >
            Received
          </button>
          <button
            type="button"
            className={`filter-segment-btn ${filter === 'sent' ? 'active' : ''}`}
            onClick={() => setFilter('sent')}
          >
            Sent
          </button>
        </div>
      </div>

      {/* 3. Main Transfer Activity List */}
      <main className="activity-scroll-area">
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
            onCancelAll={handleBatchCancelAll}
          />
        )}

        {/* Empty State */}
        {filteredMessages.length === 0 && (
          <div className="empty-state-card">
            <div className="empty-icon-circle">
              <ArrowDownUp size={24} />
            </div>
            <h3 className="empty-title">
              {messages.length === 0
                ? 'No transfers yet'
                : `No ${filter} transfers`}
            </h3>
            <p className="empty-description">
              {messages.length === 0
                ? `Files and text transferred between your phone and ${pairing?.serverName || 'Desktop'} will appear here.`
                : `No transfers match the "${filter}" filter.`}
            </p>
            {messages.length === 0 && (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="btn btn-secondary btn-compact"
              >
                Send Files
              </button>
            )}
          </div>
        )}

        {/* Date Grouped Activity Feed */}
        {dateGroupOrder.map(group => {
          const groupItems = groupedMessages[group];
          if (!groupItems || groupItems.length === 0) return null;

          return (
            <section key={group} className="date-group-section">
              <div className="date-section-header">
                <span>{group}</span>
              </div>

              <div className="date-group-cards">
                {groupItems.map(item => (
                  <TransferCard
                    key={item.id}
                    item={item}
                    isDeleting={deletingIds.has(item.id)}
                    onCopy={handleCopy}
                    onDownload={handleDownload}
                    onDelete={handleDelete}
                    onOpenLightbox={(src, filename, size, downloadCb) => {
                      setLightboxImage({
                        src,
                        filename,
                        fileSize: size,
                        onDownload: downloadCb
                      });
                    }}
                    onAcceptApproval={(id, file) => {
                      updateFile(id, { isPendingApproval: false });
                      handleDownload(id, { ...file, isPendingApproval: false }, false);
                    }}
                    onAlwaysTrustApproval={(id, file) => {
                      setIsPcTrusted(true);
                      localStorage.setItem('p2p_trust_pc', 'true');
                      updateFile(id, { isPendingApproval: false });
                      showToast('PC marked as trusted device', 'success');
                      handleDownload(id, { ...file, isPendingApproval: false }, false);
                    }}
                    onRejectApproval={(id) => {
                      handleDelete(id);
                      showToast('Transfer rejected', 'info');
                    }}
                    onPauseUpload={(id) => {
                      const u = uploads.get(id);
                      if (u) uploadQueue.pause(u);
                    }}
                    onResumeUpload={(id) => {
                      const u = uploads.get(id);
                      if (u) uploadQueue.enqueue(u);
                    }}
                    onCancelUpload={cancelUpload}
                    onToast={showToast}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </main>

      {/* Hidden Native File Input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={handleFileUpload}
      />

      {/* 4. Purpose-Built Transfer Action Panel (Replacing Chat Composer) */}
      <TransferActionPanel
        onOpenFilePicker={() => fileInputRef.current?.click()}
        onOpenSendText={() => setIsSendTextOpen(true)}
      />

      {/* 5. Dedicated Text & Link Entry Modal */}
      <SendTextModal
        isOpen={isSendTextOpen}
        onClose={() => setIsSendTextOpen(false)}
        onSend={handleSendText}
      />

      {/* 6. Native Confirmation Dialog */}
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
