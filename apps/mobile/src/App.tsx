import React, { useState, useEffect, useRef } from 'react';
import { WebSocketTransport } from './lib/transport';
import { Message } from './lib/protocol';
import { HttpError, Pairing, ServerApi, isNetworkError, pairWithApproval, pairWithQr } from './lib/api';
import { randomHex } from './lib/crypto';
import { downloadEncrypted, saveToDeviceDownloads, downloadWithSystemManager } from './lib/downloads';
import { CHUNK_SIZE, Upload, UploadQueue, UploadStatus, transferIdFor, BatchStats } from './lib/uploads';
import {
  Send, Smartphone, Paperclip, QrCode, LogOut,
  Trash2, Download, Pause, Play, X, UploadCloud, Lock, Wifi, ZoomIn, Clock,
  Copy, ArrowDownLeft, ArrowUpRight, ShieldCheck, ShieldAlert, Unlink, MoreVertical
} from 'lucide-react';
import { checkPendingShare, onSharedData } from './lib/shareTarget';
import { Capacitor } from '@capacitor/core';
import { Html5Qrcode } from 'html5-qrcode';
import { Clipboard } from '@capacitor/clipboard';
import { backButtonManager } from './lib/backButton';
import {
  MediaKind, getMediaKind, formatBytes, formatSpeed, extractTextSnippet
} from './lib/telemetry';
import { saveBlobToCache, getBlobFromCache, generateThumbnailDataUrl } from './lib/storage';
import { ToastContainer, ToastMessage } from './components/Toast';
import { Lightbox } from './components/Lightbox';
import { AudioPlayer } from './components/AudioPlayer';
import { VideoPlayer } from './components/VideoPlayer';
import { PdfViewer } from './components/PdfViewer';
import { CodeViewer } from './components/CodeViewer';
import { BatchProgress } from './components/BatchProgress';

function isImageFilename(name: string): boolean {
  return /\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i.test(name);
}

const transport = new WebSocketTransport();
const api = new ServerApi();
const uploadQueue = new UploadQueue();
const uploads = new Map<string, Upload>(); // live uploads by message id

const defaultAddress = () => window.location.port ? window.location.host : `${window.location.hostname}:8080`;
const savedAddress = () => localStorage.getItem('p2p_address') || defaultAddress();

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
  return 'Browser';
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
  return `${timedOut ? 'No answer from' : 'Could not reach'} the PC at ${host}. Check that the address is right, the PC app is running, ` +
    'Windows Firewall allows it (run "Start P2P.bat" as administrator once), and your Wi-Fi does not isolate devices ' +
    '(public or campus Wi-Fi often blocks phone-to-PC traffic; try a phone hotspot).';
};

const DIRECT_DOWNLOAD_ABOVE = 100 * 1024 * 1024;
const usesDirectDownload = (file: { totalSize: number }) =>
  file.totalSize > DIRECT_DOWNLOAD_ABOVE;

const ACTIVE_UPLOAD: string[] = ['queued', 'uploading', 'paused', 'error'];

interface ChatMessage {
  id: string;
  text?: string;
  file?: {
    filename: string;
    transferId: string;
    totalSize: number;
    totalChunks: number;
    chunkSize: number;
    isDownloading?: boolean;
    progress?: number;
    blobUrl?: string;
    thumbnailUrl?: string;
    status?: UploadStatus | 'interrupted';
    speed?: number;
    eta?: string;
    error?: string;
    mediaKind?: MediaKind;
    snippet?: string;
    fullContent?: string;
    totalLines?: number;
    isPendingApproval?: boolean;
  };
  sender: 'me' | 'other';
  timestamp: number;
  isClipboard?: boolean;
  isPending?: boolean;
}

export default function App() {
  const [status, setStatus] = useState<'connected' | 'disconnected' | 'connecting' | 'error'>('connecting');
  const [address, setAddress] = useState(savedAddress);
  const [pairing, setPairing] = useState<Pairing | null>(() => api.pairing);
  const [deviceName, setDeviceName] = useState(() => localStorage.getItem('p2p_device_name') || guessDeviceName());
  const [connectError, setConnectError] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [isPcTrusted, setIsPcTrusted] = useState<boolean>(() => localStorage.getItem('p2p_trust_pc') !== 'false');
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    const saved = localStorage.getItem('p2p_messages');
    const restored: ChatMessage[] = saved ? JSON.parse(saved) : [];
    return restored.map(m => m.file?.status && ACTIVE_UPLOAD.includes(m.file.status) && !uploads.has(m.id)
      ? { ...m, file: { ...m.file, status: 'interrupted' as const, speed: 0 } }
      : m);
  });
  const [pendingOutbox, setPendingOutbox] = useState<Message[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('p2p_outbox') || '[]');
    } catch {
      return [];
    }
  });
  const [inputValue, setInputValue] = useState('');
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [isDragging, setIsDragging] = useState(false);
  const [batchStats, setBatchStats] = useState<BatchStats>(() => uploadQueue.getStats());
  const [isBatchPaused, setIsBatchPaused] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const prevMsgCountRef = useRef(0);

  const handleContainerScroll = () => {
    const el = chatContainerRef.current;
    if (!el) return;
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isNearBottomRef.current = distanceToBottom < 90;
  };

  const [lightboxImage, setLightboxImage] = useState<{
    src: string;
    filename: string;
    fileSize?: number;
    onDownload?: () => void;
  } | null>(null);

  const dragDepth = useRef(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const showToast = (text: string, type: 'info' | 'success' | 'warning' = 'info') => {
    const id = `toast-${Date.now()}-${Math.random()}`;
    setToasts(prev => [...prev, { id, text, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 2600);
  };

  const dismissToast = (id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  // Initialize Capacitor Android back button listener & Esc key manager
  useEffect(() => {
    backButtonManager.init(showToast);
  }, []);

  // Listen to batch transfer updates from UploadQueue
  useEffect(() => {
    return uploadQueue.onBatchChange((stats) => {
      setBatchStats(stats);
      if (stats.activeCount === 0 && stats.pendingCount === 0) {
        setIsBatchPaused(false);
      }
    });
  }, []);

  // Persist messages in localStorage without dead blob URLs
  useEffect(() => {
    const toSave = messages.map(m => {
      if (!m.file) return m;
      const { blobUrl, ...restFile } = m.file;
      return { ...m, file: restFile };
    });
    localStorage.setItem('p2p_messages', JSON.stringify(toSave));
  }, [messages]);

  // Persist pending outbox in localStorage
  useEffect(() => {
    localStorage.setItem('p2p_outbox', JSON.stringify(pendingOutbox));
  }, [pendingOutbox]);

  const updateFile = (id: string, patch: Partial<NonNullable<ChatMessage['file']>>) => {
    setMessages(prev => prev.map(m => m.id === id && m.file ? { ...m, file: { ...m.file, ...patch } } : m));
  };

  // Restore cached blobs for images/media across app restarts from IndexedDB
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

  // Flush offline outbox whenever connection is restored and auto-resume stalled transfers
  useEffect(() => {
    if (status === 'connected' && transport.isConnected()) {
      uploadQueue.resumeInterrupted(uploads.values());
      if (pendingOutbox.length > 0) {
        for (const msg of pendingOutbox) {
          transport.send(JSON.stringify(msg));
          setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, isPending: false } : m));
        }
        setPendingOutbox([]);
        showToast(`Delivered ${pendingOutbox.length} pending message(s)`, 'success');
      }
    }
  }, [status, pendingOutbox]);

  // Network online listener: auto-reconnect and resume transfers when Wi-Fi recovers
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

  // Android Share Target integration: receive shared text or files from other apps
  useEffect(() => {
    const handleShare = async (data: any) => {
      if (!data) return;
      if (data.text) {
        setInputValue(data.text);
        showToast('Shared text loaded into message', 'info');
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
    }, 300);
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
        setConnectError('This device is no longer paired with the PC. Scan its QR code or enter a new pairing code.');
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

          // Automatically download small images (< 25 MB) only if PC is trusted
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

  // Android foreground resume auto-reconnect & clipboard sync
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
          } catch {
            // Permission denied or clipboard empty
          }
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  // Global paste handler: paste images/files from clipboard (Ctrl+V anywhere in app)
  useEffect(() => {
    const handleWindowPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files || []);
      if (files.length > 0) {
        e.preventDefault();
        files.forEach(sendFile);
        showToast(`Uploading ${files.length} pasted file${files.length > 1 ? 's' : ''}`, 'success');
      }
    };
    window.addEventListener('paste', handleWindowPaste);
    return () => window.removeEventListener('paste', handleWindowPaste);
  }, []);

  // QR Code Scanner setup and back button handler
  useEffect(() => {
    if (!isScanning) return;

    const unregisterBack = backButtonManager.push(() => {
      setIsScanning(false);
      return true;
    });

    setCameraError('');
    const html5QrCode = new Html5Qrcode('qr-reader');
    html5QrCode.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 250, height: 250 } },
      (decodedText) => {
        html5QrCode.stop().then(() => setIsScanning(false)).catch(() => { });
        const link = parsePairingLink(decodedText);
        setAddress(link.host);
        if (link.code) {
          pairAndConnect(link.host, link.code, link.scheme || 'http', link.cert);
        } else if (api.pairing) {
          localStorage.setItem('p2p_address', link.host);
          localStorage.setItem('p2p_auto_connect', 'true');
          connectTo(link.host).catch(console.error);
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

  // Scroll to bottom smoothly only when a new message is added and user is near bottom
  useEffect(() => {
    if (status === 'connected') {
      const isNew = messages.length > prevMsgCountRef.current;
      prevMsgCountRef.current = messages.length;
      if (isNew) {
        const last = messages[messages.length - 1];
        if (last?.sender === 'me' || isNearBottomRef.current) {
          setTimeout(() => {
            messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
          }, 35);
        }
      }
    }
  }, [messages.length, status]);

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    const host = address.trim().replace(/^https?:\/\//, '').split('/')[0];
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
    showToast('Disconnected from PC', 'info');
  };

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    const text = inputValue.trim();
    if (!text) return;

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

    setInputValue('');
  };

  // Keyboard shortcut in message input: Enter to send, Shift+Enter for newline
  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend(e);
    }
  };

  // Handle single or multi-file selection from file picker
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

    // Immediately create preview blob/snippet for sent files
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
      if (p.status === 'done' || p.status === 'canceled') uploads.delete(msgId);
    });
    uploads.set(msgId, upload);

    const resumedFrom = messages.find(m => m.id === msgId)?.file;
    setMessages(prev => [...prev.filter(m => m.id !== msgId), {
      id: msgId,
      file: {
        filename: file.name,
        transferId,
        totalSize: file.size,
        totalChunks: upload.totalChunks,
        chunkSize: CHUNK_SIZE,
        status: 'queued',
        progress: resumedFrom?.status === 'interrupted' ? resumedFrom.progress : 0,
        blobUrl,
        thumbnailUrl,
        mediaKind: kind,
        snippet,
        fullContent,
        totalLines
      },
      sender: 'me',
      timestamp: Date.now()
    }]);

    uploadQueue.enqueue(upload);
  };

  const uploadLabel = (file: NonNullable<ChatMessage['file']>) => {
    const percent = `${Math.floor(file.progress || 0)}%`;
    switch (file.status) {
      case 'queued': return 'Queued in batch...';
      case 'uploading':
        return `Uploading ${percent}${file.speed ? ` • ${formatSpeed(file.speed)}` : ''}${file.eta ? ` • ${file.eta}` : ''}`;
      case 'paused': return `Paused • ${percent}`;
      case 'error': return `Stalled at ${percent} • ${file.error || 'connection lost'}`;
      case 'interrupted': return `Interrupted at ${percent} • select again to resume`;
      case 'canceled': return 'Cancelled';
      default: return '';
    }
  };

  const handleDownload = async (msgId: string, file: NonNullable<ChatMessage['file']>, save = false) => {
    if (!file || file.isDownloading) return;
    const isPreview = !save;
    if (isPreview && file.blobUrl) return;

    // If saving and already cached or loaded, save directly to Downloads!
    if (!isPreview && file.blobUrl) {
      try {
        let blob = await getBlobFromCache(file.transferId);
        if (!blob) {
          const resp = await fetch(file.blobUrl);
          blob = await resp.blob();
        }
        if (blob) {
          await saveToDeviceDownloads(blob, file.filename);
          showToast(`Saved ${file.filename} to Downloads`, 'success');
          return;
        }
      } catch (err) {
        console.warn('Direct save from cache failed, falling back:', err);
      }
    }

    if (usesDirectDownload(file) && !isPreview) {
      const directUrl = await api.directDownloadUrl(file.transferId);
      await downloadWithSystemManager(directUrl, file.filename);
      updateFile(msgId, { progress: 100 });
      showToast(`Downloading ${file.filename} to Downloads...`, 'info');
      return;
    }

    updateFile(msgId, { isDownloading: true, progress: 0, speed: 0, eta: undefined, error: undefined });
    try {
      const blob = await downloadEncrypted(api, file, (received, speed, eta) => {
        updateFile(msgId, {
          progress: file.totalSize ? (received / file.totalSize) * 100 : 100,
          speed,
          eta
        });
      });

      const kind = file.mediaKind || getMediaKind(file.filename);
      const blobUrl = URL.createObjectURL(blob);
      let thumbnailUrl: string | undefined = undefined;

      if (kind === 'image') {
        thumbnailUrl = await generateThumbnailDataUrl(blob);
      }
      saveBlobToCache(file.transferId, blob);

      let snippet: string | undefined;
      let fullContent: string | undefined;
      let totalLines: number | undefined;

      if (kind === 'code') {
        const extracted = await extractTextSnippet(blob);
        snippet = extracted.snippet;
        fullContent = extracted.fullContent;
        totalLines = extracted.totalLines;
      }

      if (isPreview) {
        updateFile(msgId, {
          isDownloading: false,
          progress: 100,
          blobUrl,
          thumbnailUrl: thumbnailUrl || file.thumbnailUrl,
          snippet,
          fullContent,
          totalLines,
          speed: 0,
          eta: undefined
        });
      } else {
        await saveToDeviceDownloads(blob, file.filename);
        updateFile(msgId, {
          isDownloading: false,
          progress: 100,
          blobUrl: file.blobUrl || blobUrl,
          thumbnailUrl: thumbnailUrl || file.thumbnailUrl,
          snippet,
          fullContent,
          totalLines,
          speed: 0,
          eta: undefined
        });
        showToast(`Saved ${file.filename} to Downloads`, 'success');
      }
    } catch (err) {
      console.error('Download failed', err);
      updateFile(msgId, {
        isDownloading: false,
        progress: 0,
        speed: 0,
        eta: undefined,
        error: err instanceof Error ? err.message : 'Download failed'
      });
      showToast('Download failed', 'warning');
    }
  };

  const formatTime = (ts: number) => {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  // Batch control handlers
  const handleBatchPauseAll = () => {
    uploadQueue.pauseAll();
    setIsBatchPaused(true);
    showToast('Paused all uploads', 'info');
  };

  const handleBatchResumeAll = () => {
    // Re-enqueue all paused uploads
    for (const [msgId, upload] of Array.from(uploads.entries())) {
      if (upload.status === 'paused' || upload.status === 'error') {
        uploadQueue.enqueue(upload);
        updateFile(msgId, { status: 'queued' });
      }
    }
    setIsBatchPaused(false);
    showToast('Resuming uploads', 'info');
  };

  const handleBatchCancelAll = () => {
    uploadQueue.cancelAll();
    uploads.clear();
    setIsBatchPaused(false);
    showToast('Cancelled batch transfers', 'info');
  };

  const getFileExt = (filename: string) => {
    const idx = filename.lastIndexOf('.');
    if (idx <= 0 || idx === filename.length - 1) return 'FILE';
    return filename.slice(idx + 1).toUpperCase().slice(0, 4);
  };

  const getItemTypeLabel = (msg: ChatMessage) => {
    if (msg.isClipboard) return 'Clipboard';
    if (msg.file) {
      const k = msg.file.mediaKind || getMediaKind(msg.file.filename);
      if (k === 'image') return 'Image';
      if (k === 'audio') return 'Audio';
      if (k === 'video') return 'Video';
      if (k === 'pdf') return 'PDF';
      if (k === 'code') return 'Code';
      return getFileExt(msg.file.filename);
    }
    return 'Text';
  };

  // Render Setup / Pairing Screen when disconnected
  if (status !== 'connected') {
    return (
      <div className="app-container">
        <ToastContainer toasts={toasts} onDismiss={dismissToast} />
        <header className="header">
          <div className="header-left">
            <div className="brand-badge">
              <Wifi size={16} />
            </div>
            <div className="header-brand-stack">
              <span className="header-title">P2P Link</span>
              <span className="header-subtitle">Encrypted Local Transfer</span>
            </div>
          </div>
          <div className="status-indicator">
            <div className={`status-dot ${status}`}></div>
            <span>{status === 'connecting' ? 'Connecting' : 'Standby'}</span>
          </div>
        </header>

        <main className="setup-screen">
          <div className="card">
            <div className="setup-hero-icon">
              <Smartphone size={26} />
            </div>

            {isScanning ? (
              <div>
                <h2 style={{ marginBottom: '0.5rem', fontSize: '1.25rem' }}>Scan PC QR Code</h2>
                <p style={{ fontSize: '0.84rem', color: 'var(--text-secondary)', marginBottom: '1.25rem' }}>
                  Point your camera at the QR code shown in the desktop terminal
                </p>
                <div id="qr-reader" style={{ width: '100%', marginBottom: '1.25rem', borderRadius: '14px', overflow: 'hidden', border: '1px solid rgba(255,255,255,0.1)' }}></div>
                <button
                  onClick={() => setIsScanning(false)}
                  className="secondary-btn"
                  style={{ width: '100%' }}
                >
                  Cancel Scanner
                </button>
              </div>
            ) : (
              <>
                <h2 className="setup-title">{pairing ? 'Connect to Desktop' : 'Link New Device'}</h2>
                <div className="setup-description">
                  {pairing ? (
                    <>
                      Linked with <span className="setup-peer-highlight">{pairing.serverName || 'Desktop PC'}</span> as <span className="setup-peer-highlight">{pairing.deviceName}</span>
                    </>
                  ) : (
                    'Scan the QR code in your desktop terminal or enter the local IP address below.'
                  )}
                </div>

                {cameraError && (
                  <div className="setup-alert">
                    {cameraError}
                  </div>
                )}

                {connectError && !cameraError && (
                  <div className="setup-alert">
                    {connectError}
                  </div>
                )}

                <button
                  onClick={() => setIsScanning(true)}
                  className="qr-scan-btn"
                >
                  <QrCode size={18} />
                  <span>{pairing ? 'Scan QR to Reconnect' : 'Scan QR Code'}</span>
                </button>

                <div className="setup-divider">
                  <span>OR MANUAL ADDRESS</span>
                </div>

                <form onSubmit={handleConnect}>
                  <div className="input-group">
                    <label>Desktop IP & Port</label>
                    <input
                      type="text"
                      className="text-input mono-input"
                      value={address}
                      onChange={e => setAddress(e.target.value)}
                      placeholder="192.168.1.x:8080"
                    />
                  </div>
                  {!pairing && (
                    <div className="input-group">
                      <label>Device Name</label>
                      <input
                        type="text"
                        className="text-input"
                        value={deviceName}
                        onChange={e => setDeviceName(e.target.value)}
                        maxLength={40}
                      />
                    </div>
                  )}
                  <button
                    type="submit"
                    className="primary-btn"
                    disabled={status === 'connecting'}
                  >
                    {status === 'connecting' ? (pairing ? 'Connecting...' : 'Awaiting PC approval...') : !pairing ? 'Pair & Connect' : 'Connect via Wi-Fi'}
                  </button>

                  {pairing && (
                    <button
                      type="button"
                      onClick={async () => {
                        if (window.confirm('Forget and unpair this PC? You will need to scan the QR code to pair again.')) {
                          try {
                            await api.unpair();
                          } catch {}
                          savePairing(null);
                          showToast('Device forgotten and unpaired', 'info');
                        }
                      }}
                      className="secondary-btn"
                      style={{ marginTop: '0.75rem', width: '100%', color: '#ff453a', borderColor: 'rgba(255, 69, 58, 0.3)' }}
                    >
                      Forget This PC
                    </button>
                  )}
                </form>
              </>
            )}
          </div>
        </main>
      </div>
    );
  }

  // Connected Workspace & Transfer Interface
  return (
    <div
      className="app-container"
      onDragEnter={handleDragEnter}
      onDragOver={e => { if (hasFiles(e)) e.preventDefault(); }}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />

      {lightboxImage && (
        <Lightbox
          src={lightboxImage.src}
          filename={lightboxImage.filename}
          fileSize={lightboxImage.fileSize}
          onClose={() => setLightboxImage(null)}
          onDownload={lightboxImage.onDownload}
        />
      )}

      {isDragging && (
        <div className="drop-overlay">
          <UploadCloud size={44} color="var(--accent-color)" />
          <span style={{ fontSize: '1.1rem' }}>Drop files to transfer instantly</span>
          <span style={{ fontSize: '0.85rem', opacity: 0.8 }}>End-to-end encrypted direct stream</span>
        </div>
      )}

      <header className="header">
        <div className="header-left">
          <div className="brand-badge connected">
            <Wifi size={16} />
          </div>
          <div className="header-brand-stack">
            <div className="header-title-row">
              <span className="header-title">P2P Link</span>
              <span className="e2e-badge" title="End-to-End Encrypted">
                <Lock size={10} />
                <span>E2EE</span>
              </span>
            </div>
            <div className="header-peer-row">
              <span className="peer-dot" />
              <span className="peer-name">{pairing?.serverName || 'Desktop PC'}</span>
            </div>
          </div>
        </div>

        <div className="header-actions">
          <button
            type="button"
            onClick={() => setIsMenuOpen(o => !o)}
            className="header-icon-btn"
            title="Options & History"
          >
            <MoreVertical size={18} />
          </button>

          {isMenuOpen && (
            <>
              <div className="menu-backdrop" onClick={() => setIsMenuOpen(false)} />
              <div className="header-dropdown-menu">
                <button
                  type="button"
                  className="menu-item"
                  onClick={() => {
                    const next = !isPcTrusted;
                    setIsPcTrusted(next);
                    localStorage.setItem('p2p_trust_pc', next ? 'true' : 'false');
                    showToast(next ? 'PC marked as trusted (auto-accept)' : 'Transfers require approval', 'info');
                    setIsMenuOpen(false);
                  }}
                >
                  {isPcTrusted ? <ShieldCheck size={16} color="#32d74b" /> : <ShieldAlert size={16} color="#ffd60a" />}
                  <span>{isPcTrusted ? 'Auto-Accept Transfers' : 'Require Approval'}</span>
                </button>
                <button
                  type="button"
                  className="menu-item"
                  onClick={() => {
                    setIsMenuOpen(false);
                    if (window.confirm('Clear transfer history on this device?')) {
                      setMessages(prev => prev.filter(m => uploads.has(m.id)));
                      showToast('Transfer history cleared', 'info');
                    }
                  }}
                >
                  <Trash2 size={16} />
                  <span>Clear History</span>
                </button>
                <button
                  type="button"
                  className="menu-item"
                  onClick={() => {
                    setIsMenuOpen(false);
                    handleDisconnect();
                  }}
                >
                  <LogOut size={16} />
                  <span>Disconnect</span>
                </button>
                <div className="menu-divider" />
                <button
                  type="button"
                  className="menu-item danger"
                  onClick={async () => {
                    setIsMenuOpen(false);
                    if (window.confirm('Forget and unpair this PC? You will need to scan the QR code to pair again.')) {
                      try {
                        await api.unpair();
                      } catch {}
                      savePairing(null);
                      transport.disconnect();
                      setStatus('disconnected');
                      showToast('Device unpaired and access revoked', 'info');
                    }
                  }}
                >
                  <Unlink size={16} />
                  <span>Forget This PC</span>
                </button>
              </div>
            </>
          )}
        </div>
      </header>

      <main className="chat-container" ref={chatContainerRef} onScroll={handleContainerScroll}>
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

        <div className="message-list">
          <div style={{ flex: '1 1 auto', minHeight: '0.25rem' }} />
          {messages.length === 0 && (
            <div className="empty-state">
              <div className="empty-radar-glow">
                <div className="radar-ring radar-ring-1" />
                <div className="radar-ring radar-ring-2" />
                <div className="radar-center">
                  <Wifi size={24} color="#38bdf8" />
                </div>
              </div>
              <h3>Linked with {pairing?.serverName || 'Desktop'}</h3>
              <p>Transfer files, photos, clipboard snippets, or text directly over local Wi-Fi.</p>
              <div className="empty-quick-actions">
                <button type="button" onClick={() => fileInputRef.current?.click()} className="quick-action-pill">
                  <Paperclip size={14} /> Select Files to Send
                </button>
              </div>
            </div>
          )}

          {messages.map(msg => {
            const isSent = msg.sender === 'me';
            const isImageFile = msg.file && (msg.file.mediaKind === 'image' || (!msg.file.mediaKind && /\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i.test(msg.file.filename)));

            return (
              <div key={msg.id} className={`message-wrapper ${msg.sender} ${deletingIds.has(msg.id) ? 'deleting' : ''}`}>
                <div className={`message ${msg.sender}`}>
                  {/* Structured Transfer Card Header */}
                  <div className="transfer-card-header">
                    <div className="transfer-card-meta">
                      <span className={`direction-badge ${isSent ? 'sent' : 'received'}`}>
                        {isSent ? <ArrowUpRight size={12} /> : <ArrowDownLeft size={12} />}
                        <span>{isSent ? 'Sent' : 'Received'}</span>
                      </span>
                      <span className="type-badge">{getItemTypeLabel(msg)}</span>
                      <span className="timestamp-label">{formatTime(msg.timestamp)}</span>
                      {msg.isPending && (
                        <span className="pending-pill" title="Queued — will send when connected">
                          <Clock size={10} />
                          <span>Queued</span>
                        </span>
                      )}
                    </div>

                    <div className="transfer-card-actions">
                      {msg.text && (
                        <button
                          type="button"
                          onClick={() => handleCopy(msg.text!)}
                          className="card-action-pill"
                          title="Copy text"
                        >
                          <Copy size={12} />
                          <span>Copy</span>
                        </button>
                      )}
                      {msg.file && (
                        <button
                          type="button"
                          onClick={() => handleDownload(msg.id, msg.file!, true)}
                          disabled={msg.file.isDownloading}
                          className="card-action-pill accent"
                          title="Save to Downloads"
                        >
                          <Download size={12} />
                          <span>{msg.file.isDownloading ? `${Math.round(msg.file.progress || 0)}%` : 'Save'}</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => handleDelete(msg.id)}
                        className="msg-delete-btn"
                        title="Remove item"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>

                  {/* Text / Clipboard Payload */}
                  {msg.text && (
                    <div onClick={() => handleCopy(msg.text!)} className="transfer-text-block" title="Tap to copy">
                      {msg.text}
                    </div>
                  )}

                  {/* Per-Transfer Approval Box */}
                  {msg.file && msg.file.isPendingApproval && (
                    <div className="transfer-approval-box">
                      <div className="transfer-approval-info">
                        Incoming file from PC ({formatBytes(msg.file.totalSize)}). Accept transfer?
                      </div>
                      <div className="transfer-approval-btn-group">
                        <button
                          type="button"
                          className="approval-btn danger"
                          onClick={() => {
                            handleDelete(msg.id);
                            showToast('Transfer rejected', 'info');
                          }}
                        >
                          Reject
                        </button>
                        <button
                          type="button"
                          className="approval-btn primary"
                          onClick={() => {
                            updateFile(msg.id, { isPendingApproval: false });
                            handleDownload(msg.id, { ...msg.file!, isPendingApproval: false }, false);
                          }}
                        >
                          Accept
                        </button>
                        <button
                          type="button"
                          className="approval-btn success"
                          onClick={() => {
                            setIsPcTrusted(true);
                            localStorage.setItem('p2p_trust_pc', 'true');
                            updateFile(msg.id, { isPendingApproval: false });
                            showToast('PC marked as trusted device', 'success');
                            handleDownload(msg.id, { ...msg.file!, isPendingApproval: false }, false);
                          }}
                        >
                          Always Trust
                        </button>
                      </div>
                    </div>
                  )}

                  {/* File / Media Payload */}
                  {msg.file && !msg.file.isPendingApproval && (
                    <div className="transfer-file-container">
                      {(msg.file.blobUrl || msg.file.thumbnailUrl) && isImageFile ? (
                        <div
                          className="image-preview-wrapper"
                          onClick={() => {
                            const src = msg.file!.blobUrl || msg.file!.thumbnailUrl!;
                            setLightboxImage({
                              src,
                              filename: msg.file!.filename,
                              fileSize: msg.file!.totalSize,
                              onDownload: () => handleDownload(msg.id, msg.file!, true)
                            });
                          }}
                        >
                          <img
                            src={msg.file.blobUrl || msg.file.thumbnailUrl}
                            alt={msg.file.filename}
                            loading="lazy"
                            onError={() => {
                              getBlobFromCache(msg.file!.transferId).then(blob => {
                                if (blob) {
                                  updateFile(msg.id, { blobUrl: URL.createObjectURL(blob) });
                                }
                              });
                            }}
                          />
                          <div className="image-preview-caption">
                            <span className="image-caption-name">{msg.file.filename}</span>
                            <span className="image-caption-size">{formatBytes(msg.file.totalSize || 0)}</span>
                          </div>
                          <div className="image-preview-overlay">
                            <ZoomIn size={16} />
                            <span>Inspect</span>
                          </div>
                        </div>
                      ) : msg.file.blobUrl && msg.file.mediaKind === 'audio' ? (
                        <AudioPlayer
                          src={msg.file.blobUrl}
                          filename={msg.file.filename}
                          fileSize={msg.file.totalSize}
                          onDownload={() => handleDownload(msg.id, msg.file!, true)}
                        />
                      ) : msg.file.blobUrl && msg.file.mediaKind === 'video' ? (
                        <VideoPlayer
                          src={msg.file.blobUrl}
                          filename={msg.file.filename}
                          fileSize={msg.file.totalSize}
                          onDownload={() => handleDownload(msg.id, msg.file!, true)}
                        />
                      ) : msg.file.blobUrl && msg.file.mediaKind === 'pdf' ? (
                        <PdfViewer
                          src={msg.file.blobUrl}
                          filename={msg.file.filename}
                          fileSize={msg.file.totalSize}
                          onDownload={() => handleDownload(msg.id, msg.file!, true)}
                        />
                      ) : msg.file.snippet ? (
                        <CodeViewer
                          filename={msg.file.filename}
                          snippet={msg.file.snippet}
                          fullContent={msg.file.fullContent}
                          totalLines={msg.file.totalLines}
                          fileSize={msg.file.totalSize}
                          onDownload={() => handleDownload(msg.id, msg.file!, true)}
                          onCopyNotice={showToast}
                        />
                      ) : (
                        /* Structured File Row */
                        <div className="file-item-row">
                          <div className="file-ext-badge">
                            <span>{getFileExt(msg.file.filename)}</span>
                          </div>
                          <div className="file-item-details">
                            <span className="file-item-name">{msg.file.filename}</span>
                            <span className="file-item-size">{formatBytes(msg.file.totalSize || 0)}</span>
                          </div>
                          {(msg.file.mediaKind === 'image' || msg.file.mediaKind === 'audio' || msg.file.mediaKind === 'video' || msg.file.mediaKind === 'code' || msg.file.mediaKind === 'pdf') && !msg.file.blobUrl && (
                            <button
                              type="button"
                              className="file-row-action-btn"
                              onClick={() => handleDownload(msg.id, msg.file!, false)}
                              disabled={msg.file.isDownloading}
                            >
                              Preview
                            </button>
                          )}
                        </div>
                      )}

                      {/* Sender upload progress */}
                      {isSent && msg.file.status && msg.file.status !== 'done' && (
                        <div>
                          {msg.file.status !== 'canceled' && (
                            <div className="shimmer-bar-container" style={{ marginTop: '0.35rem' }}>
                              <div
                                className="shimmer-bar-fill"
                                style={{ width: `${msg.file.progress || 0}%` }}
                              />
                            </div>
                          )}
                          <div className="transfer-status">
                            <span>{uploadLabel(msg.file)}</span>
                            {msg.file.status !== 'canceled' && (
                              <span className="transfer-actions">
                                {(msg.file.status === 'uploading' || msg.file.status === 'queued') && (
                                  <button onClick={() => uploadQueue.pause(uploads.get(msg.id)!)} className="icon-btn" title="Pause">
                                    <Pause size={14} />
                                  </button>
                                )}
                                {(msg.file.status === 'paused' || msg.file.status === 'error') && (
                                  <button onClick={() => uploadQueue.enqueue(uploads.get(msg.id)!)} className="icon-btn" title="Resume">
                                    <Play size={14} />
                                  </button>
                                )}
                                <button onClick={() => cancelUpload(msg.id, msg.file!.transferId)} className="icon-btn" title="Cancel">
                                  <X size={14} />
                                </button>
                              </span>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Receiver active download telemetry */}
                      {!isSent && msg.file.isDownloading && (
                        <div style={{ marginTop: '0.35rem' }}>
                          <div className="shimmer-bar-container">
                            <div
                              className="shimmer-bar-fill"
                              style={{ width: `${msg.file.progress || 0}%` }}
                            />
                          </div>
                          <div className="transfer-status">
                            <span>Receiving {Math.round(msg.file.progress || 0)}%{msg.file.speed ? ` • ${formatSpeed(msg.file.speed)}` : ''}</span>
                            <span>{msg.file.eta || ''}</span>
                          </div>
                        </div>
                      )}

                      {msg.file.error && !msg.file.isDownloading && (
                        <div className="transfer-note" style={{ color: 'var(--error-color)' }}>{msg.file.error}</div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>
      </main>

      <form className="input-area" onSubmit={handleSend}>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={handleFileUpload}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="input-attach-btn"
          title="Send Files or Photos"
        >
          <Paperclip size={18} />
        </button>

        <input
          type="text"
          className="text-input"
          value={inputValue}
          onChange={e => setInputValue(e.target.value)}
          onKeyDown={handleInputKeyDown}
          placeholder="Send text, link, or attach files..."
        />

        <button
          type="submit"
          className="send-btn"
          disabled={!inputValue.trim()}
          title="Transfer"
        >
          <Send size={16} />
        </button>
      </form>
    </div>
  );
}
