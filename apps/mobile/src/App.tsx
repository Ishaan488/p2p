import React, { useState, useEffect, useRef } from 'react';
import { WebSocketTransport } from './lib/transport';
import { Message } from './lib/protocol';
import { Send, Smartphone, File as FileIcon, Paperclip, QrCode, LogOut } from 'lucide-react';
import { Html5Qrcode } from 'html5-qrcode';

const transport = new WebSocketTransport();

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
  };
  sender: 'me' | 'other';
  timestamp: number;
}

export default function App() {
  const [status, setStatus] = useState<'connected' | 'disconnected' | 'connecting' | 'error'>('connecting');
  const [address, setAddress] = useState(() => localStorage.getItem('p2p_address') || `${window.location.hostname}:8080`);
  const [isScanning, setIsScanning] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    const saved = localStorage.getItem('p2p_messages');
    return saved ? JSON.parse(saved) : [];
  });
  const [inputValue, setInputValue] = useState('');
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
        }
      } catch (e) {
        console.error("Failed to parse message", e);
      }
    });

    if (localStorage.getItem('p2p_auto_connect') !== 'false') {
      const target = localStorage.getItem('p2p_address') || `${window.location.hostname}:8080`;
      transport.connect(target).catch(console.error);
    }

    return () => transport.disconnect();
  }, []);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && !transport.isConnected() && localStorage.getItem('p2p_auto_connect') !== 'false') {
        const target = localStorage.getItem('p2p_address') || `${window.location.hostname}:8080`;
        transport.connect(target).catch(console.error);
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
          html5QrCode.stop().then(() => setIsScanning(false)).catch(() => {});
          setAddress(decodedText);
          localStorage.setItem('p2p_address', decodedText);
          localStorage.setItem('p2p_auto_connect', 'true');
          transport.connect(decodedText).catch(console.error);
        }, 
        () => {}
      ).catch(err => {
        console.error("Camera error", err);
        setCameraError("Camera access denied or unsupported. Browser may require HTTPS.");
        setIsScanning(false);
      });

      return () => {
        if (html5QrCode.isScanning) {
          html5QrCode.stop().catch(() => {});
        }
      };
    }
  }, [isScanning]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleConnect = async (e: React.FormEvent, directAddress?: string) => {
    if (e) e.preventDefault();
    const addrToUse = directAddress || address;
    localStorage.setItem('p2p_address', addrToUse);
    localStorage.setItem('p2p_auto_connect', 'true');
    try {
      await transport.connect(addrToUse);
    } catch (e) {
      console.error(e);
    }
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
    const file = e.target.files?.[0];
    if (!file) return;

    // Reset input so same file can be chosen again
    e.target.value = '';

    // Android Chrome drops WebSockets when tabs go to the background (e.g., when the file picker opens)
    // We seamlessly reconnect here before proceeding!
    if (!transport.isConnected()) {
      setStatus('connecting');
      try {
        const target = localStorage.getItem('p2p_address') || address;
        localStorage.setItem('p2p_auto_connect', 'true');
        await transport.connect(target);
      } catch (err) {
        console.error("Failed to reconnect before upload", err);
        return;
      }
    }

    const transferId = `transfer-${Date.now()}-${file.name}`;
    const chunkSize = 65536;
    const totalChunks = Math.ceil(file.size / chunkSize);
    const timestamp = Math.floor(Date.now() / 1000);

    // 1. Send file_start over WS
    transport.send(JSON.stringify({
      version: 1,
      type: 'file_start',
      id: `msg-${transferId}`,
      timestamp,
      payload: {
        transferId,
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
        totalSize: file.size,
        chunkSize,
        totalChunks,
        checksum: 'pending' // client-side hash omitted for brevity
      }
    }));

    // Add to UI
    const msgId = `msg-${transferId}`;
    setMessages(prev => [...prev, {
      id: msgId,
      file: {
        filename: file.name,
        transferId,
        totalSize: file.size,
        totalChunks,
        chunkSize,
        isDownloading: true,
        progress: 0
      },
      sender: 'me',
      timestamp: Date.now()
    }]);

    // 2. Upload chunks via HTTP
    const host = address.split('/')[0]; // fallback strip path
    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, file.size);
      const chunk = file.slice(start, end);
      
      try {
        const res = await fetch(`http://${host}/upload?transferId=${transferId}&chunkIndex=${i}&chunkSize=${chunkSize}`, {
          method: 'POST',
          body: chunk
        });
        
        if (!res.ok) {
           throw new Error(`Upload failed with status ${res.status}`);
        }

        // Update progress
        setMessages(prev => prev.map(m => {
          if (m.id === msgId && m.file) {
            return { ...m, file: { ...m.file, progress: ((i + 1) / totalChunks) * 100 } };
          }
          return m;
        }));
      } catch (err) {
        console.error("Chunk upload failed", err);
        return; // Abort transfer if a chunk fails
      }
    }

    // 3. Send file_complete over WS
    transport.send(JSON.stringify({
      version: 1,
      type: 'file_complete',
      id: `msg-complete-${transferId}`,
      timestamp: Math.floor(Date.now() / 1000),
      payload: {
        transferId,
        checksum: 'pending'
      }
    }));

    // Mark complete
    setMessages(prev => prev.map(m => {
      if (m.id === msgId && m.file) {
        return { ...m, file: { ...m.file, isDownloading: false, progress: 100 } };
      }
      return m;
    }));
  };

  const handleDownload = async (msgId: string, file: NonNullable<ChatMessage['file']>) => {
    if (!file || file.isDownloading || file.blobUrl) return;

    setMessages(prev => prev.map(m => m.id === msgId ? { ...m, file: { ...m.file!, isDownloading: true, progress: 0 } } : m));

    const host = address.split('/')[0];
    const chunks: BlobPart[] = [];

    for (let i = 0; i < file.totalChunks; i++) {
      try {
        const res = await fetch(`http://${host}/download?transferId=${file.transferId}&chunkIndex=${i}&chunkSize=${file.chunkSize}`);
        const buf = await res.arrayBuffer();
        chunks.push(buf);

        setMessages(prev => prev.map(m => m.id === msgId ? { ...m, file: { ...m.file!, progress: ((i + 1) / file.totalChunks) * 100 } } : m));
      } catch (err) {
        console.error("Chunk download failed", err);
        break;
      }
    }

    const blob = new Blob(chunks);
    const url = URL.createObjectURL(blob);

    setMessages(prev => prev.map(m => m.id === msgId ? { ...m, file: { ...m.file!, isDownloading: false, progress: 100, blobUrl: url } } : m));
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
                <h2 style={{ marginBottom: '1.5rem' }}>Connect to PC</h2>
                
                {cameraError && (
                  <div style={{ padding: '0.75rem', background: 'rgba(239, 68, 68, 0.2)', border: '1px solid var(--error-color)', borderRadius: '8px', marginBottom: '1rem', color: 'var(--error-color)', fontSize: '0.875rem' }}>
                    {cameraError}
                  </div>
                )}
                
                {status === 'error' && !cameraError && (
                  <div style={{ padding: '0.75rem', background: 'rgba(239, 68, 68, 0.2)', border: '1px solid var(--error-color)', borderRadius: '8px', marginBottom: '1rem', color: 'var(--error-color)', fontSize: '0.875rem' }}>
                    Connection timed out. Are you on the exact same Wi-Fi network as your PC?
                  </div>
                )}

                <button 
                  onClick={() => setIsScanning(true)}
                  className="primary-btn"
                  style={{ marginBottom: '1.5rem', background: 'var(--bg-primary)', border: '1px solid var(--accent-color)' }}
                >
                  <QrCode size={18} style={{ display: 'inline', verticalAlign: 'middle', marginRight: '8px' }} />
                  Scan to Connect
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
                  <button 
                    type="submit" 
                    className="primary-btn"
                    disabled={status === 'connecting'}
                  >
                    {status === 'connecting' ? 'Connecting...' : 'Connect via Wi-Fi'}
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
    <div className="app-container">
      <header className="header">
        <div className="header-title">P2P Link</div>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <div className="status-indicator">
            <div className="status-dot connected"></div>
            <span>Connected</span>
          </div>
          <button 
            onClick={handleDisconnect} 
            style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
            title="Disconnect"
          >
            <LogOut size={20} />
          </button>
        </div>
      </header>

      <main className="chat-container">
        <div className="message-list">
          {messages.map(msg => (
            <div key={msg.id} className={`message-wrapper ${msg.sender}`}>
              <div className={`message ${msg.sender}`}>
                {msg.text && <div>{msg.text}</div>}
                {msg.file && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', minWidth: '200px' }}>
                    {msg.file.blobUrl && msg.file.filename.match(/\.(jpg|jpeg|png|gif|webp)$/i) ? (
                      <img src={msg.file.blobUrl} alt={msg.file.filename} style={{ maxWidth: '100%', borderRadius: '8px', maxHeight: '250px', objectFit: 'cover' }} />
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', fontWeight: 500, background: 'rgba(0,0,0,0.1)', padding: '0.75rem', borderRadius: '8px' }}>
                        <div style={{ background: 'var(--accent-color)', padding: '0.5rem', borderRadius: '8px', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <FileIcon size={20} /> 
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                          <span style={{ whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden', fontSize: '0.9rem' }}>{msg.file.filename}</span>
                          <span style={{ fontSize: '0.75rem', opacity: 0.8, fontWeight: 400 }}>{formatFileSize(msg.file.totalSize || 0)}</span>
                        </div>
                      </div>
                    )}
                    
                    {msg.sender === 'me' && msg.file.progress !== undefined && msg.file.progress < 100 && (
                      <div className="progress-bar-container" style={{ height: '6px', background: 'rgba(255,255,255,0.2)', borderRadius: '3px', overflow: 'hidden', marginTop: '4px' }}>
                        <div className="progress-bar-fill" style={{ height: '100%', background: '#fff', width: `${msg.file.progress}%`, transition: 'width 0.2s' }}></div>
                      </div>
                    )}
                    
                    {msg.sender !== 'me' && !msg.file.blobUrl && (
                      <div style={{ marginTop: '0.25rem' }}>
                        {msg.file.progress !== undefined && msg.file.progress > 0 && msg.file.progress < 100 && (
                          <div className="progress-bar-container" style={{ height: '6px', background: 'rgba(0,0,0,0.2)', borderRadius: '3px', overflow: 'hidden', marginBottom: '0.75rem' }}>
                            <div className="progress-bar-fill" style={{ height: '100%', background: 'var(--accent-color)', width: `${msg.file.progress}%`, transition: 'width 0.2s' }}></div>
                          </div>
                        )}
                        <button 
                          className="primary-btn" 
                          onClick={() => handleDownload(msg.id, msg.file!)} 
                          disabled={msg.file.isDownloading}
                          style={{ width: '100%', padding: '0.5rem', background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid rgba(255,255,255,0.1)' }}
                        >
                          {msg.file.isDownloading ? `Downloading ${Math.round(msg.file.progress || 0)}%` : 'Download File'}
                        </button>
                      </div>
                    )}
                    
                    {msg.sender !== 'me' && msg.file.blobUrl && !msg.file.filename.match(/\.(jpg|jpeg|png|gif|webp)$/i) && (
                      <button 
                        className="primary-btn" 
                        onClick={() => {
                          const a = document.createElement('a');
                          a.href = msg.file!.blobUrl!;
                          a.download = msg.file!.filename;
                          a.click();
                        }}
                        style={{ width: '100%', padding: '0.5rem', background: 'var(--accent-gradient)' }}
                      >
                        Save to Device
                      </button>
                    )}
                  </div>
                )}
                <div className="message-time">{formatTime(msg.timestamp)}</div>
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
      </main>

      <form className="input-area" onSubmit={handleSend}>
          <label style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0.5rem' }}>
            <input type="file" style={{ display: 'none' }} onChange={handleFileUpload} />
            <Paperclip size={24} color="var(--accent-color)" />
          </label>
          <input 
            type="text" 
            className="text-input"
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            placeholder="Type a message..."
            autoFocus
          />
          <button type="submit" className="send-btn" disabled={!inputValue.trim()}>
            <Send size={20} />
          </button>
        </form>
    </div>
  );
}
