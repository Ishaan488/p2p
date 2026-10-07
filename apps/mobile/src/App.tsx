import React, { useState, useEffect, useRef } from 'react';
import { WebSocketTransport } from './lib/transport';
import { Message } from './lib/protocol';
import { HttpError, Pairing, ServerApi, pairDevice } from './lib/api';
import { randomHex } from './lib/crypto';
import { CHUNK_SIZE, Upload, UploadQueue, UploadStatus, transferIdFor } from './lib/uploads';
import { Send, Smartphone, File as FileIcon, Paperclip, QrCode, LogOut, Trash2, Download, Pause, Play, X, UploadCloud } from 'lucide-react';
import { Html5Qrcode } from 'html5-qrcode';
import { Clipboard } from '@capacitor/clipboard';

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

// A pairing QR code is a link to the app with the code in the fragment
// (http://192.168.1.5:8080/#pair=CODE); older ones are a bare "ip:port".
const parsePairingLink = (text: string): { host: string; code?: string } => {
  try {
    const url = new URL(text);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return { host: url.host, code: new URLSearchParams(url.hash.slice(1)).get('pair') || undefined };
    }
  } catch {
    // not a URL
  }
  return { host: text.trim() };
};

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
    // Uploads only. 'interrupted' = the app was reloaded mid-transfer.
    status?: UploadStatus | 'interrupted';
    speed?: number;
    error?: string;
  };
  sender: 'me' | 'other';
  timestamp: number;
  isClipboard?: boolean;
}

export default function App() {
  const [status, setStatus] = useState<'connected' | 'disconnected' | 'connecting' | 'error'>('connecting');
  const [address, setAddress] = useState(savedAddress);
  const [pairing, setPairing] = useState<Pairing | null>(() => api.pairing);
  const [pairCode, setPairCode] = useState('');
  const [deviceName, setDeviceName] = useState(() => localStorage.getItem('p2p_device_name') || guessDeviceName());
  const [connectError, setConnectError] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    const saved = localStorage.getItem('p2p_messages');
    const restored: ChatMessage[] = saved ? JSON.parse(saved) : [];
    // Uploads do not survive a reload, but the server keeps their chunks.
    return restored.map(m => m.file?.status && ACTIVE_UPLOAD.includes(m.file.status) && !uploads.has(m.id)
      ? { ...m, file: { ...m.file, status: 'interrupted' as const, speed: 0 } }
      : m);
  });
  const [inputValue, setInputValue] = useState('');
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [isDragging, setIsDragging] = useState(false);
  const dragDepth = useRef(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  useEffect(() => {
    localStorage.setItem('p2p_messages', JSON.stringify(messages));
  }, [messages]);

  const updateFile = (id: string, patch: Partial<NonNullable<ChatMessage['file']>>) => {
    setMessages(prev => prev.map(m => m.id === id && m.file ? { ...m, file: { ...m.file, ...patch } } : m));
  };

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
    if (file?.status && file.status !== 'done' && file.status !== 'canceled') cancelUpload(id, file.transferId);
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
    api.host = target.split('/')[0]; // fallback strip path
    setConnectError('');
    if (!api.pairing) {
      setStatus('disconnected');
      throw new Error('Not paired');
    }
    setStatus('connecting');
    let url: string;
    try {
      url = await api.wsUrl();
    } catch (err) {
      if (err instanceof HttpError && err.code === 'not_paired') {
        savePairing(null);
        setConnectError('This device is no longer paired with the PC. Scan its QR code or enter a new pairing code.');
        setStatus('disconnected');
      } else {
        setStatus('error');
      }
      throw err;
    }
    return transport.connect(url);
  };

  // Pairs with the PC at `host` (the code comes from its QR code or terminal) and connects.
  const pairAndConnect = async (host: string, code: string) => {
    setConnectError('');
    setStatus('connecting');
    setAddress(host);
    try {
      const name = deviceName.trim() || guessDeviceName();
      localStorage.setItem('p2p_device_name', name);
      savePairing(await pairDevice(host, code, getDeviceId(), name));
    } catch (err) {
      setStatus('disconnected');
      setConnectError(err instanceof HttpError ? err.message : `Could not reach the PC at ${host}. Are you on the same Wi-Fi network?`);
      return;
    }
    localStorage.setItem('p2p_address', host);
    localStorage.setItem('p2p_auto_connect', 'true');
    setPairCode('');
    await connectTo(host).catch(console.error);
  };

  const fallbackCopyTextToClipboard = (text: string) => {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.top = "0";
    textArea.style.left = "0";
    textArea.style.position = "fixed";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
      document.execCommand('copy');
    } catch (err) {
      console.error('Fallback: unable to copy', err);
    }
    document.body.removeChild(textArea);
  };

  const handleCopy = async (text: string) => {
    try {
      // This calls the native Android OS clipboard directly! Bypasses all browser restrictions.
      await Clipboard.write({ string: text });
      console.log("Copied via Native Capacitor Clipboard");
    } catch (e) {
      // Fallback for when running in standard PC browser
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => fallbackCopyTextToClipboard(text));
      } else {
        fallbackCopyTextToClipboard(text);
      }
    }
  };

  useEffect(() => {
    transport.onStatusChange(setStatus);
    transport.onMessage((data) => {
      try {
        const msg: Message = JSON.parse(data);
        if (msg.type === 'text') {
          setMessages(prev => [...prev, {
            id: msg.id,
            text: msg.payload.text,
            sender: 'other',
            timestamp: msg.timestamp * 1000
          }]);
        } else if (msg.type === 'file_start') {
          setMessages(prev => [...prev, {
            id: msg.id,
            file: {
              filename: msg.payload.filename,
              transferId: msg.payload.transferId,
              totalSize: msg.payload.totalSize,
              totalChunks: msg.payload.totalChunks,
              chunkSize: msg.payload.chunkSize,
              isDownloading: false,
              progress: 0,
            },
            sender: 'other',
            timestamp: msg.timestamp * 1000
          }]);
        } else if (msg.type === 'clipboard') {
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
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(msg.payload.text)
                .then(() => console.log("Clipboard auto-synced from PC"))
                .catch(fallback);
            } else {
              fallback(); // HTTP context fallback
            }
          } catch (err) {
            fallback();
          }
        }
      } catch (e) {
        console.error("Failed to parse message", e);
      }
    });

    // Opened from the pairing QR code: the code is in the URL fragment.
    const linkCode = new URLSearchParams(window.location.hash.slice(1)).get('pair');
    if (linkCode) {
      history.replaceState(null, '', window.location.pathname);
      pairAndConnect(window.location.host, linkCode);
    } else if (api.pairing && localStorage.getItem('p2p_auto_connect') !== 'false') {
      connectTo(savedAddress()).catch(console.error);
    } else {
      setStatus('disconnected');
    }

    return () => transport.disconnect();
  }, []);

  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'visible') {
        let isReady = transport.isConnected();
        if (!isReady && api.pairing && localStorage.getItem('p2p_auto_connect') !== 'false') {
          try {
            await connectTo(savedAddress());
            isReady = true;
          } catch (e) { console.error(e); }
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
          } catch (e) {
            // Permission denied or clipboard empty
          }
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  useEffect(() => {
    if (isScanning) {
      setCameraError('');
      const html5QrCode = new Html5Qrcode("qr-reader");
      html5QrCode.start({ facingMode: "environment" }, { fps: 10, qrbox: { width: 250, height: 250 } },
        (decodedText) => {
          html5QrCode.stop().then(() => setIsScanning(false)).catch(() => { });
          const link = parsePairingLink(decodedText);
          setAddress(link.host);
          if (link.code) {
            pairAndConnect(link.host, link.code);
          } else if (api.pairing) {
            localStorage.setItem('p2p_address', link.host);
            localStorage.setItem('p2p_auto_connect', 'true');
            connectTo(link.host).catch(console.error);
          } else {
            setConnectError('That QR code has no pairing code. Type "pair" on the PC to show a new one.');
          }
        },
        () => { }
      ).catch(err => {
        console.error("Camera error", err);
        setCameraError("Camera access denied or unsupported. Browser may require HTTPS.");
        setIsScanning(false);
      });

      return () => {
        if (html5QrCode.isScanning) {
          html5QrCode.stop().catch(() => { });
        }
      };
    }
  }, [isScanning]);

  useEffect(() => {
    if (status === 'connected') {
      setTimeout(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      }, 50);
    }
  }, [messages, status]);

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    const host = address.trim();
    if (pairCode.trim()) {
      await pairAndConnect(host, pairCode);
      return;
    }
    if (!pairing) {
      setConnectError('Enter the pairing code shown in the PC terminal (type "pair" there to get one).');
      return;
    }
    localStorage.setItem('p2p_address', host);
    localStorage.setItem('p2p_auto_connect', 'true');
    await connectTo(host).catch(console.error);
  };

  const handleDisconnect = () => {
    localStorage.setItem('p2p_auto_connect', 'false');
    transport.disconnect();
    setStatus('disconnected');
  };

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim() || status !== 'connected') return;

    const id = `msg-${Date.now()}`;
    const timestamp = Math.floor(Date.now() / 1000);

    const msg: Message = {
      version: 1,
      type: 'text',
      id,
      timestamp,
      payload: { text: inputValue.trim() }
    };

    transport.send(JSON.stringify(msg));

    setMessages(prev => [...prev, {
      id,
      text: inputValue.trim(),
      sender: 'me',
      timestamp: Date.now()
    }]);

    setInputValue('');
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    // Reset input so same file can be chosen again
    e.target.value = '';

    // Android Chrome drops WebSockets when tabs go to the background (e.g., when the file picker opens)
    // We seamlessly reconnect here before proceeding!
    if (!transport.isConnected()) {
      setStatus('connecting');
      try {
        localStorage.setItem('p2p_auto_connect', 'true');
        await connectTo(savedAddress());
      } catch (err) {
        console.error("Failed to reconnect before upload", err);
        return;
      }
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
    // Folders show up as entries that cannot be read as a file, so leave them out.
    Array.from(e.dataTransfer.items)
      .filter(item => item.kind === 'file' && !item.webkitGetAsEntry?.()?.isDirectory)
      .map(item => item.getAsFile())
      .forEach(file => file && sendFile(file));
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length === 0) return;
    e.preventDefault();
    files.forEach(sendFile);
  };

  const sendFile = (file: File) => {
    const transferId = transferIdFor(getDeviceId(), file);
    const msgId = `msg-${transferId}`;

    // Same file while it is still in flight: just make sure it is moving.
    const running = uploads.get(msgId);
    if (running) {
      uploadQueue.enqueue(running);
      return;
    }

    let blobUrl: string | undefined = undefined;
    if (file.name.match(/\.(jpg|jpeg|png|gif|webp)$/i) && file.size < 20 * 1024 * 1024) {
      blobUrl = URL.createObjectURL(file);
    }

    // Chunks go over HTTP, several at a time. Re-sending a file that was
    // interrupted earlier maps to the same transfer id, so it resumes.
    const upload = new Upload(api, file, transferId, p => {
      // Until the server has reported what it already holds, keep the old progress on screen.
      const progress = p.status === 'queued' ? {} : { progress: p.totalBytes ? (p.sentBytes / p.totalBytes) * 100 : 100 };
      updateFile(msgId, { status: p.status, speed: p.speed, error: p.error, ...progress });
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
        blobUrl
      },
      sender: 'me',
      timestamp: Date.now()
    }]);

    uploadQueue.enqueue(upload);
  };

  const uploadLabel = (file: NonNullable<ChatMessage['file']>) => {
    const percent = `${Math.floor(file.progress || 0)}%`;
    switch (file.status) {
      case 'queued': return 'Queued';
      case 'uploading': return `Uploading ${percent}${file.speed ? ` • ${formatFileSize(file.speed)}/s` : ''}`;
      case 'paused': return `Paused • ${percent}`;
      case 'error': return `Stalled at ${percent} • ${file.error || 'connection lost'}`;
      case 'interrupted': return `Interrupted at ${percent} • select the file again to resume`;
      case 'canceled': return 'Cancelled';
      default: return '';
    }
  };

  const handleDownload = async (msgId: string, file: NonNullable<ChatMessage['file']>, forceNative = false) => {
    if (!file || file.isDownloading || (file.blobUrl && !forceNative)) return;

    const url = await api.downloadUrl(file.transferId);

    if (!forceNative && file.filename.match(/\.(jpg|jpeg|png|gif|webp)$/i) && file.totalSize < 20 * 1024 * 1024) {
      // For small images (<20MB), set the blobUrl so the UI displays it immediately
      setMessages(prev => prev.map(m => m.id === msgId ? { ...m, file: { ...m.file!, isDownloading: false, progress: 100, blobUrl: url } } : m));
    } else {
      // For other files, trigger native browser download (0 RAM usage!)
      // In Capacitor/Android WebView, a.click() often silently fails for downloads.
      // window.open with _blank will reliably trigger the native OS browser to handle the download stream.
      window.open(url, '_blank');

      if (!forceNative) {
        setMessages(prev => prev.map(m => m.id === msgId ? { ...m, file: { ...m.file!, isDownloading: false, progress: 100 } } : m));
      }
    }
  };

  const formatTime = (ts: number) => {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  if (status !== 'connected') {
    return (
      <div className="app-container">
        <header className="header">
          <div className="header-title">P2P Link</div>
          <div className="status-indicator">
            <div className={`status-dot ${status}`}></div>
            <span>{status === 'connecting' ? 'Connecting...' : 'Disconnected'}</span>
          </div>
        </header>

        <main className="setup-screen">
          <div className="card">
            <Smartphone size={48} style={{ color: 'var(--accent-color)', margin: '0 auto 1.5rem', display: 'block' }} />

            {isScanning ? (
              <div>
                <h2 style={{ marginBottom: '1rem' }}>Scan QR Code</h2>
                <div id="qr-reader" style={{ width: '100%', marginBottom: '1.5rem', borderRadius: '8px', overflow: 'hidden' }}></div>
                <button onClick={() => setIsScanning(false)} style={{ background: 'transparent', color: 'var(--text-secondary)', border: 'none', cursor: 'pointer' }}>Cancel</button>
              </div>
            ) : (
              <>
                <h2 style={{ marginBottom: '0.5rem' }}>{pairing ? 'Connect to PC' : 'Pair with PC'}</h2>
                <div style={{ fontSize: '0.9rem', marginBottom: '2rem', textAlign: 'center', lineHeight: '1.4', color: 'var(--text-secondary)' }}>
                  {pairing
                    ? `Paired with ${pairing.serverName || 'your PC'} as "${pairing.deviceName}". Ensure both are on the same network.`
                    : 'Scan the QR code shown in the PC terminal. Ensure your phone and pc are on same network.'}
                </div>

                {cameraError && (
                  <div style={{ padding: '0.75rem', background: 'rgba(239, 68, 68, 0.2)', border: '1px solid var(--error-color)', borderRadius: '8px', marginBottom: '1rem', color: 'var(--error-color)', fontSize: '0.875rem' }}>
                    {cameraError}
                  </div>
                )}

                {connectError && !cameraError && (
                  <div style={{ padding: '0.75rem', background: 'rgba(239, 68, 68, 0.2)', border: '1px solid var(--error-color)', borderRadius: '8px', marginBottom: '1rem', color: 'var(--error-color)', fontSize: '0.875rem' }}>
                    {connectError}
                  </div>
                )}

                {status === 'error' && !cameraError && !connectError && (
                  <div style={{ padding: '0.75rem', background: 'rgba(239, 68, 68, 0.2)', border: '1px solid var(--error-color)', borderRadius: '8px', marginBottom: '1rem', color: 'var(--error-color)', fontSize: '0.875rem' }}>
                    Connection timed out. Are you on the exact same Wi-Fi network as your PC?
                  </div>
                )}

                <button
                  onClick={() => setIsScanning(true)}
                  className="primary-btn"
                  style={{ marginBottom: '1.5rem', background: 'transparent', border: '1px solid var(--accent-color)', color: 'var(--accent-color)' }}
                >
                  <QrCode size={18} style={{ display: 'inline', verticalAlign: 'middle', marginRight: '8px' }} />
                  {pairing ? 'Scan to Connect' : 'Scan to Pair'}
                </button>

                <div style={{ margin: '1rem 0', opacity: 0.5, fontSize: '0.875rem' }}>OR ENTER MANUALLY</div>

                <form onSubmit={handleConnect}>
                  <div className="input-group">
                    <label>Windows IP Address & Port</label>
                    <input
                      type="text"
                      className="text-input"
                      value={address}
                      onChange={e => setAddress(e.target.value)}
                      placeholder="192.168.1.x:8080"
                    />
                  </div>
                  <div className="input-group">
                    <label>Pairing Code{pairing ? ' (only to pair again)' : ''}</label>
                    <input
                      type="text"
                      className="text-input"
                      value={pairCode}
                      onChange={e => setPairCode(e.target.value)}
                      placeholder="XXXX-XXXX-XXXX-XXXX"
                      autoCapitalize="characters"
                      autoCorrect="off"
                      spellCheck={false}
                    />
                  </div>
                  {(!pairing || pairCode.trim()) && (
                    <div className="input-group">
                      <label>Name of This Device</label>
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
                    {status === 'connecting' ? 'Connecting...' : pairCode.trim() || !pairing ? 'Pair & Connect' : 'Connect via Wi-Fi'}
                  </button>
                </form>
              </>
            )}
          </div>
        </main>
      </div>
    );
  }

  return (
    <div
      className="app-container"
      onDragEnter={handleDragEnter}
      onDragOver={e => { if (hasFiles(e)) e.preventDefault(); }}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="drop-overlay">
          <UploadCloud size={40} />
          <span>Drop files to send</span>
        </div>
      )}
      <header className="header">
        <div className="header-title">P2P Link</div>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <button
            onClick={() => setMessages(prev => prev.filter(m => uploads.has(m.id)))}
            className="icon-btn"
            title="Clear History"
          >
            <Trash2 size={18} />
          </button>
          <div className="status-indicator">
            <div className="status-dot connected"></div>
            <span>Connected</span>
          </div>
          <button
            onClick={handleDisconnect}
            className="icon-btn"
            title="Disconnect"
          >
            <LogOut size={18} />
          </button>
        </div>
      </header>

      <main className="chat-container">
        <div className="message-list">
          {messages.map(msg => (
            <div key={msg.id} className={`message-wrapper ${msg.sender} ${deletingIds.has(msg.id) ? 'deleting' : ''}`}>
              <div className={`message ${msg.sender}`}>
                {msg.text && (
                  <div onClick={() => handleCopy(msg.text!)} className="interactive-text" title="Tap to copy">
                    {msg.isClipboard ? (
                      <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <div style={{ fontSize: '0.75rem', opacity: 0.7, marginBottom: '0.4rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                          <span>📋</span> PC Clipboard
                        </div>
                        <div>{msg.text}</div>
                      </div>
                    ) : (
                      msg.text
                    )}
                  </div>
                )}
                {msg.file && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', minWidth: '200px' }}>
                    {msg.file.blobUrl && msg.file.filename.match(/\.(jpg|jpeg|png|gif|webp)$/i) ? (
                      <div style={{ position: 'relative', width: '100%', borderRadius: '0.35rem', overflow: 'hidden', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.05)' }}>
                        <img 
                          src={msg.file.blobUrl} 
                          alt={msg.file.filename} 
                          style={{ width: '100%', maxHeight: '400px', objectFit: 'contain', display: 'block' }} 
                          onError={() => {
                            // If PC disconnects or clears RAM, the image link breaks. Fallback to standard file view!
                            setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, file: { ...m.file!, blobUrl: undefined } } : m));
                          }}
                        />
                        {msg.sender !== 'me' && (
                          <button
                            onClick={() => handleDownload(msg.id, msg.file!, true)}
                            className="icon-btn"
                            style={{ position: 'absolute', bottom: '0.5rem', right: '0.5rem', background: 'rgba(0,0,0,0.65)', color: 'white', padding: '0.5rem', backdropFilter: 'blur(4px)', opacity: 1 }}
                            title="Download Image"
                          >
                            <Download size={16} />
                          </button>
                        )}
                      </div>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', fontWeight: 500, background: 'rgba(255,255,255,0.015)', padding: '0.65rem', borderRadius: '0.5rem', border: '1px solid rgba(255,255,255,0.03)' }}>
                        <div style={{ background: 'rgba(255,255,255,0.05)', padding: '0.5rem', borderRadius: '0.35rem', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <FileIcon size={20} />
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                          <span style={{ whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden', fontSize: '0.9rem' }}>{msg.file.filename}</span>
                          <span style={{ fontSize: '0.75rem', opacity: 0.8, fontWeight: 400 }}>{formatFileSize(msg.file.totalSize || 0)}</span>
                        </div>
                      </div>
                    )}

                    {msg.sender === 'me' && msg.file.status && msg.file.status !== 'done' && (
                      <div>
                        {msg.file.status !== 'canceled' && (
                          <div className="progress-bar-container" style={{ height: '4px', background: 'rgba(255,255,255,0.2)', borderRadius: '2px', overflow: 'hidden', marginTop: '0.5rem' }}>
                            <div className="progress-bar-fill" style={{ height: '100%', background: '#fff', width: `${msg.file.progress || 0}%`, transition: 'width 0.3s cubic-bezier(0.4, 0, 0.2, 1)' }}></div>
                          </div>
                        )}
                        <div className="transfer-status">
                          <span>{uploadLabel(msg.file)}</span>
                          {msg.file.status !== 'canceled' && (
                            <span className="transfer-actions">
                              {(msg.file.status === 'uploading' || msg.file.status === 'queued') && (
                                <button onClick={() => uploadQueue.pause(uploads.get(msg.id)!)} className="icon-btn" title="Pause">
                                  <Pause size={16} />
                                </button>
                              )}
                              {(msg.file.status === 'paused' || msg.file.status === 'error') && (
                                <button onClick={() => uploadQueue.enqueue(uploads.get(msg.id)!)} className="icon-btn" title="Resume">
                                  <Play size={16} />
                                </button>
                              )}
                              <button onClick={() => cancelUpload(msg.id, msg.file!.transferId)} className="icon-btn" title="Cancel">
                                <X size={16} />
                              </button>
                            </span>
                          )}
                        </div>
                      </div>
                    )}

                    {msg.sender !== 'me' && !msg.file.blobUrl && (
                      <div style={{ marginTop: '0.25rem' }}>
                        {msg.file.progress !== undefined && msg.file.progress > 0 && msg.file.progress < 100 && (
                          <div className="progress-bar-container" style={{ height: '4px', background: 'rgba(255,255,255,0.05)', borderRadius: '2px', overflow: 'hidden', marginBottom: '0.75rem' }}>
                            <div className="progress-bar-fill" style={{ height: '100%', background: 'rgba(255,255,255,0.8)', width: `${msg.file.progress}%`, transition: 'width 0.3s cubic-bezier(0.4, 0, 0.2, 1)' }}></div>
                          </div>
                        )}
                        <button
                          className="primary-btn"
                          onClick={() => handleDownload(msg.id, msg.file!)}
                          disabled={msg.file.isDownloading}
                          style={{ width: '100%', padding: '0.75rem', borderRadius: '0.75rem', background: 'rgba(255,255,255,0.05)', color: 'var(--text-primary)', border: '1px solid rgba(255,255,255,0.05)', fontWeight: 600 }}
                        >
                          {msg.file.isDownloading ? `Downloading ${Math.round(msg.file.progress || 0)}%` : 'Download File'}
                        </button>
                      </div>
                    )}

                    {msg.sender !== 'me' && msg.file.blobUrl && !msg.file.filename.match(/\.(jpg|jpeg|png|gif|webp)$/i) && (
                      <button
                        className="primary-btn"
                        onClick={() => {
                          window.open(msg.file!.blobUrl!, '_blank');
                        }}
                        style={{ width: '100%', padding: '0.65rem', borderRadius: '0.5rem', background: 'rgba(255,255,255,0.1)', color: 'white', border: 'none', fontWeight: 500 }}
                      >
                        {msg.file.filename.match(/\.(jpg|jpeg|png|gif|webp)$/i) && msg.file.totalSize < 20 * 1024 * 1024 ? 'Preview Image' : 'Save to Device'}
                      </button>
                    )}
                  </div>
                )}
                <div className="message-time">
                  <span>{msg.sender === 'me' ? 'Sent' : 'Received'} • {formatTime(msg.timestamp)}</span>
                  <button onClick={() => handleDelete(msg.id)} className="icon-btn" style={{ padding: '0.2rem' }} title="Delete">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
      </main>

      <form className="input-area" onSubmit={handleSend}>
        <label style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0.5rem' }}>
          <input type="file" multiple style={{ display: 'none' }} onChange={handleFileUpload} />
          <Paperclip size={24} color="var(--text-secondary)" />
        </label>
        <input
          type="text"
          className="text-input"
          value={inputValue}
          onChange={e => setInputValue(e.target.value)}
          onPaste={handlePaste}
          placeholder="Type a message..."
        />
        <button type="submit" className="send-btn" disabled={!inputValue.trim()}>
          <Send size={20} />
        </button>
      </form>
    </div>
  );
}
