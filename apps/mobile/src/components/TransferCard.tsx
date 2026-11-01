import React, { useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  ArrowUp,
  RotateCcw,
  Copy,
  Check,
  Download,
  Trash2,
  Pause,
  Play,
  X,
  ExternalLink,
  Eye,
  Package,
  File as FileIcon,
  FileArchive,
  FileCode,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  Music,
  Video as VideoIcon,
  ShieldCheck
} from 'lucide-react';
import { formatBytes, formatSpeed, MediaKind } from '../lib/telemetry';
import { AudioPlayer } from './AudioPlayer';
import { PdfViewer } from './PdfViewer';
import { CodeViewer } from './CodeViewer';

export interface OpenMediaPayload {
  type: 'image' | 'video';
  src: string;
  filename: string;
  fileSize?: number;
  onDownload?: () => void;
}

export interface TransferItem {
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
    status?: string;
    priority?: 'high' | 'normal' | 'low';
    speed?: number;
    eta?: string;
    error?: string;
    mediaKind?: MediaKind;
    snippet?: string;
    fullContent?: string;
    totalLines?: number;
    isPendingApproval?: boolean;
    saveToDisk?: boolean;
    savedBytes?: number;
  };
  sender: 'me' | 'other';
  timestamp: number;
  isClipboard?: boolean;
  isPending?: boolean;
}

export interface TransferCardProps {
  item: TransferItem;
  isDeleting: boolean;
  onCopy: (text: string) => void;
  onDownload: (id: string, file: NonNullable<TransferItem['file']>, saveToDisk: boolean) => void;
  onDelete: (id: string) => void;
  onOpenMedia: (payload: OpenMediaPayload) => void;
  onAcceptApproval: (id: string, file: NonNullable<TransferItem['file']>) => void;
  onAlwaysTrustApproval: (id: string, file: NonNullable<TransferItem['file']>) => void;
  onRejectApproval: (id: string) => void;
  onPauseUpload: (id: string) => void;
  onResumeUpload: (id: string) => void;
  onCancelUpload: (id: string, transferId: string) => void;
  onTogglePriority?: (id: string) => void;
  onToast: (text: string, type?: 'info' | 'success' | 'warning') => void;
}

function getFileExtension(filename: string): string {
  const parts = filename.split('.');
  if (parts.length < 2) return 'FILE';
  const ext = parts.pop()?.toUpperCase() || 'FILE';
  return ext.length <= 6 ? ext : 'FILE';
}

function getFileIcon(filename: string, mediaKind?: MediaKind) {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  if (mediaKind === 'image' || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'heic', 'avif'].includes(ext)) {
    return <ImageIcon size={20} />;
  }
  if (mediaKind === 'video' || ['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v', '3gp'].includes(ext)) {
    return <VideoIcon size={20} />;
  }
  if (mediaKind === 'audio' || ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'opus'].includes(ext)) {
    return <Music size={20} />;
  }
  if (mediaKind === 'code' || ['js', 'ts', 'tsx', 'jsx', 'py', 'go', 'rs', 'c', 'cpp', 'h', 'java', 'kt', 'swift', 'html', 'css', 'json', 'yaml', 'yml', 'toml', 'xml', 'sql', 'sh'].includes(ext)) {
    return <FileCode size={20} />;
  }
  if (['apk', 'aab', 'dmg', 'exe', 'msi', 'deb', 'rpm', 'iso'].includes(ext)) {
    return <Package size={20} />;
  }
  if (['zip', 'tar', 'gz', 'tgz', 'rar', '7z', 'bz2', 'xz'].includes(ext)) {
    return <FileArchive size={20} />;
  }
  if (['xls', 'xlsx', 'csv', 'tsv', 'ods'].includes(ext)) {
    return <FileSpreadsheet size={20} />;
  }
  if (['pdf', 'doc', 'docx', 'txt', 'md', 'rtf', 'ppt', 'pptx'].includes(ext) || mediaKind === 'pdf') {
    return <FileText size={20} />;
  }
  return <FileIcon size={20} />;
}

function formatCardTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function extractFirstUrl(text?: string): string | null {
  if (!text) return null;
  const match = text.match(/https?:\/\/[^\s<>"']+/i);
  return match ? match[0] : null;
}

export const TransferCard: React.FC<TransferCardProps> = ({
  item,
  isDeleting,
  onCopy,
  onDownload,
  onDelete,
  onOpenMedia,
  onAcceptApproval,
  onAlwaysTrustApproval,
  onRejectApproval,
  onPauseUpload,
  onResumeUpload,
  onCancelUpload,
  onTogglePriority,
  onToast
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [justCopied, setJustCopied] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);

  const isSent = item.sender === 'me';
  const file = item.file;

  const isImageFile = !!file && (
    file.mediaKind === 'image' ||
    /\.(jpg|jpeg|png|gif|webp|svg|bmp|heic|avif)$/i.test(file.filename)
  );
  const isVideoFile = !!file && (
    file.mediaKind === 'video' ||
    /\.(mp4|mkv|mov|webm|avi|m4v|3gp)$/i.test(file.filename)
  );

  const hasVisualMedia = !imageFailed && (isImageFile || isVideoFile) && !!(file?.blobUrl || file?.thumbnailUrl);
  const hasRichEmbed =
    (!!file?.blobUrl && file.mediaKind === 'audio') ||
    !!file?.snippet;

  const isTextLong = !!item.text && item.text.length > 240;
  const displayText = isTextLong && !isExpanded && item.text
    ? `${item.text.slice(0, 240)}...`
    : (item.text || '');

  const detectedUrl = extractFirstUrl(item.text);
  const fileExt = file ? getFileExtension(file.filename) : '';
  const timeStr = formatCardTime(item.timestamp);

  const handleCopyClick = () => {
    if (!item.text) return;
    onCopy(item.text);
    setJustCopied(true);
    setTimeout(() => setJustCopied(false), 1800);
  };

  // Inline direction metadata pill + info row with responsive wrapping and protected text
  const renderDirectionMeta = (extraText?: string) => (
    <div
      className="meta-inline-row"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.32rem',
        fontSize: '0.72rem',
        minWidth: 0,
        flexWrap: 'wrap',
        rowGap: '2px',
        lineHeight: 1.35,
      }}
    >
      <span
        className={`dir-pill ${isSent ? 'dir-sent' : 'dir-received'}`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '3px',
          padding: '2px 7px',
          borderRadius: '9999px',
          fontSize: '0.68rem',
          fontWeight: 600,
          lineHeight: 1.3,
          flexShrink: 0,
          background: isSent ? 'var(--surface-secondary)' : 'var(--success-subtle)',
          color: isSent ? 'var(--text-secondary)' : 'var(--success)',
          border: `1px solid ${isSent ? 'var(--border-subtle)' : 'var(--success-border)'}`,
        }}
      >
        {isSent ? (
          <ArrowUpRight size={10} strokeWidth={2.5} />
        ) : (
          <ArrowDownLeft size={10} strokeWidth={2.5} />
        )}
        <span>{isSent ? 'Sent' : 'Received'}</span>
      </span>

      {extraText && (
        <span
          style={{
            flexShrink: 0,
            color: 'var(--text-secondary)',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.70rem',
            whiteSpace: 'nowrap'
          }}
        >
          <span style={{ color: 'var(--text-tertiary)', marginRight: '0.28rem' }}>·</span>
          {extraText}
        </span>
      )}

      <span
        style={{
          flexShrink: 0,
          color: 'var(--text-tertiary)',
          fontSize: '0.70rem',
          whiteSpace: 'nowrap'
        }}
      >
        <span style={{ marginRight: '0.28rem' }}>·</span>
        {timeStr}
      </span>

      {item.isPending && (
        <span
          style={{
            flexShrink: 0,
            color: 'var(--warning)',
            fontWeight: 600,
            fontSize: '0.70rem',
            whiteSpace: 'nowrap'
          }}
        >
          <span style={{ color: 'var(--text-tertiary)', marginRight: '0.28rem' }}>·</span>
          Queued
        </span>
      )}
    </div>
  );

  return (
    <article
      className={`transfer-card ${isDeleting ? 'deleting' : ''}`}
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-md)',
        padding: '0.75rem 0.85rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.55rem',
        boxShadow: 'var(--shadow-sm)',
        overflow: 'hidden',
        position: 'relative'
      }}
    >
      <style>{`
        .transfer-card {
          background: var(--surface);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-md);
          padding: 0.75rem 0.85rem;
          display: flex;
          flex-direction: column;
          gap: 0.55rem;
          box-shadow: var(--shadow-sm);
          overflow: hidden;
          position: relative;
          transition: transform var(--transition-fast, 150ms ease), opacity var(--transition-fast, 150ms ease);
          animation: cardSlideIn 220ms var(--ease-spring, cubic-bezier(0.16, 1, 0.3, 1));
        }
        .transfer-card.deleting {
          opacity: 0;
          transform: scale(0.96);
        }
        .card-pill-btn {
          display: inline-flex;
          align-items: center;
          gap: 0.3rem;
          height: 28px;
          padding: 0 0.65rem;
          border-radius: var(--radius-full, 9999px);
          background: var(--surface-secondary);
          border: 1px solid var(--border-subtle);
          color: var(--text-primary);
          font-size: 0.72rem;
          font-weight: 600;
          font-variant-numeric: tabular-nums;
          text-decoration: none;
          cursor: pointer;
          transition: transform var(--transition-fast, 150ms ease), background var(--transition-fast, 150ms ease), border-color var(--transition-fast, 150ms ease);
          white-space: nowrap;
          user-select: none;
          -webkit-user-select: none;
        }
        .card-pill-btn:hover:not(:disabled) {
          background: var(--surface-hover);
          border-color: var(--border-strong);
        }
        .card-pill-btn:active:not(:disabled) {
          transform: scale(0.96);
        }
        .card-pill-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .card-pill-primary {
          background: var(--btn-primary-bg) !important;
          color: var(--btn-primary-text) !important;
          border-color: transparent !important;
        }
        .card-pill-primary:hover:not(:disabled) {
          background: var(--btn-primary-hover) !important;
        }
        .card-icon-only-btn {
          width: 28px;
          height: 28px;
          border-radius: var(--radius-full, 9999px);
          background: transparent;
          border: none;
          color: var(--text-tertiary);
          display: inline-flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: var(--transition-fast, 150ms ease);
          flex-shrink: 0;
        }
        .card-icon-only-btn:hover,
        .card-icon-only-btn:active {
          background: var(--error-subtle);
          color: var(--error);
        }
        .media-stage-box:hover .video-play-circle,
        .media-stage-box:active .video-play-circle {
          transform: scale(1.08);
          background: var(--accent) !important;
          color: #17161D !important;
        }
        .approval-btn:active {
          transform: scale(0.97);
        }
        .progress-ctrl-btn:active {
          transform: scale(0.92);
        }
        .progress-ctrl-btn:hover {
          color: var(--text-primary);
          border-color: var(--text-tertiary);
        }
        .progress-cancel:hover {
          color: var(--error) !important;
          background: var(--error-subtle) !important;
          border-color: var(--error-border) !important;
        }
        @media (max-width: 360px) {
          .transfer-card {
            padding: 0.65rem 0.72rem;
            gap: 0.5rem;
          }
          .card-pill-btn {
            height: 26px;
            padding: 0 0.5rem;
            font-size: 0.7rem;
            gap: 0.22rem;
          }
          .card-actions-group {
            gap: 0.25rem !important;
          }
        }
      `}</style>

      {/* =========================================================
          1. TEXT OR LINK SNIPPET CARD (Single Clean Surface)
          ========================================================= */}
      {item.text && !file && (
        <div className="text-transfer-layout" style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
          <div className="text-body-wrap" style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
            <p
              className="card-text-body"
              style={{
                fontSize: '0.88rem',
                lineHeight: 1.5,
                color: 'var(--text-primary)',
                wordBreak: 'break-word',
                whiteSpace: 'pre-wrap'
              }}
            >
              {displayText}
            </p>
            {isTextLong && (
              <button
                type="button"
                className="card-text-expand-btn"
                onClick={() => setIsExpanded(e => !e)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--accent)',
                  fontSize: '0.74rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  alignSelf: 'flex-start',
                  padding: 0
                }}
              >
                {isExpanded ? 'Show less' : 'Read full text'}
              </button>
            )}
          </div>

          <div
            className="card-unified-footer"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '0.5rem',
              paddingTop: '0.5rem',
              borderTop: '1px solid var(--border-subtle)',
              minWidth: 0
            }}
          >
            <div style={{ minWidth: 0, flex: 1, overflow: 'hidden' }}>
              {renderDirectionMeta(detectedUrl ? 'Link' : `${item.text.length} chars`)}
            </div>

            <div className="card-actions-group" style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexShrink: 0 }}>
              {detectedUrl && (
                <a
                  href={detectedUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="card-pill-btn"
                  title="Open link"
                >
                  <ExternalLink size={13} />
                  <span>Open</span>
                </a>
              )}
              <button
                type="button"
                className="card-pill-btn card-pill-primary"
                onClick={handleCopyClick}
                title="Copy text"
              >
                {justCopied ? <Check size={13} /> : <Copy size={13} />}
                <span>{justCopied ? 'Copied' : 'Copy'}</span>
              </button>
              <button
                type="button"
                className="card-icon-only-btn"
                onClick={() => onDelete(item.id)}
                title="Remove"
                aria-label="Remove"
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =========================================================
          2. INCOMING FILE APPROVAL PROMPT
          ========================================================= */}
      {file && file.isPendingApproval && (
        <div className="approval-layout" style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
          <div
            className="file-row-main"
            style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', minWidth: 0 }}
          >
            <div
              className="file-squircle-icon"
              style={{
                width: '40px',
                height: '40px',
                borderRadius: '10px',
                background: 'var(--surface-secondary)',
                border: '1px solid var(--border-subtle)',
                color: 'var(--accent)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0
              }}
            >
              {getFileIcon(file.filename, file.mediaKind)}
            </div>
            <div className="file-row-text" style={{ minWidth: 0, flex: 1, overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', marginBottom: '2px' }}>
                <span
                  style={{
                    fontSize: '0.68rem',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    color: 'var(--warning)',
                    background: 'var(--warning-subtle)',
                    border: '1px solid var(--warning-border)',
                    padding: '1px 6px',
                    borderRadius: 'var(--radius-full, 9999px)'
                  }}
                >
                  Incoming File
                </span>
              </div>
              <span
                className="file-row-title"
                title={file.filename}
                style={{
                  fontSize: '0.88rem',
                  fontWeight: 600,
                  letterSpacing: '-0.01em',
                  color: 'var(--text-primary)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  display: 'block'
                }}
              >
                {file.filename}
              </span>
              {renderDirectionMeta(`${formatBytes(file.totalSize)} · ${fileExt}`)}
            </div>
          </div>

          <div
            className="approval-actions"
            style={{
              display: 'flex',
              gap: '0.4rem',
              paddingTop: '0.2rem',
              alignItems: 'center'
            }}
          >
            <button
              type="button"
              className="approval-btn approval-reject"
              onClick={() => onRejectApproval(item.id)}
              style={{
                flex: 1,
                height: '34px',
                borderRadius: '8px',
                fontSize: '0.75rem',
                fontWeight: 600,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '4px',
                background: 'var(--error-subtle)',
                color: 'var(--error)',
                border: '1px solid var(--error-border)',
                transition: 'var(--transition-fast)'
              }}
            >
              <X size={13} />
              <span>Decline</span>
            </button>
            <button
              type="button"
              className="approval-btn approval-accept"
              onClick={() => onAcceptApproval(item.id, file)}
              style={{
                flex: 1,
                height: '34px',
                borderRadius: '8px',
                fontSize: '0.75rem',
                fontWeight: 600,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '4px',
                background: 'var(--btn-primary-bg)',
                color: 'var(--btn-primary-text)',
                border: 'none',
                transition: 'var(--transition-fast)'
              }}
            >
              <Check size={13} strokeWidth={2.5} />
              <span>Accept</span>
            </button>
            <button
              type="button"
              className="approval-btn approval-trust"
              onClick={() => onAlwaysTrustApproval(item.id, file)}
              style={{
                flex: 1.1,
                height: '34px',
                borderRadius: '8px',
                fontSize: '0.75rem',
                fontWeight: 600,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '4px',
                background: 'var(--surface-secondary)',
                border: '1px solid var(--accent-border)',
                color: 'var(--accent)',
                transition: 'var(--transition-fast)'
              }}
            >
              <ShieldCheck size={13} />
              <span>Always Trust</span>
            </button>
          </div>
        </div>
      )}

      {/* =========================================================
          3. VISUAL MEDIA CARD (Image / Video Preview + Unified Footer)
          ========================================================= */}
      {file && !file.isPendingApproval && hasVisualMedia && (
        <div className="media-transfer-layout" style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
          {isImageFile ? (
            <div
              className="media-stage-box"
              style={{
                width: '100%',
                aspectRatio: '16 / 9',
                maxHeight: 'none',
                borderRadius: 'var(--radius-sm)',
                overflow: 'hidden',
                border: '1px solid var(--border-subtle)',
                background: 'var(--surface-secondary)',
                position: 'relative',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
              onClick={() => {
                const src = file.blobUrl || file.thumbnailUrl!;
                onOpenMedia({
                  type: 'image',
                  src,
                  filename: file.filename,
                  fileSize: file.totalSize,
                  onDownload: () => onDownload(item.id, file, true)
                });
              }}
            >
              <img
                src={file.blobUrl || file.thumbnailUrl}
                alt={file.filename}
                loading="lazy"
                onError={() => setImageFailed(true)}
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  display: 'block'
                }}
              />
              <div
                className="media-tap-hint"
                style={{
                  position: 'absolute',
                  bottom: '8px',
                  right: '8px',
                  background: 'rgba(23, 22, 29, 0.72)',
                  backdropFilter: 'blur(8px)',
                  WebkitBackdropFilter: 'blur(8px)',
                  color: 'var(--text-primary)',
                  borderRadius: 'var(--radius-full, 9999px)',
                  padding: '3px 8px',
                  fontSize: '0.68rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  border: '1px solid rgba(255, 255, 255, 0.12)'
                }}
              >
                <Eye size={11} />
                <span>View</span>
              </div>
            </div>
          ) : (
            <div
              className="media-stage-box video-stage"
              style={{
                width: '100%',
                aspectRatio: '16 / 9',
                height: 'auto',
                maxHeight: 'none',
                borderRadius: 'var(--radius-sm)',
                overflow: 'hidden',
                border: '1px solid var(--border-subtle)',
                background: '#09080E',
                position: 'relative',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
              onClick={() => {
                if (file.blobUrl) {
                  onOpenMedia({
                    type: 'video',
                    src: file.blobUrl,
                    filename: file.filename,
                    fileSize: file.totalSize,
                    onDownload: () => onDownload(item.id, file, true)
                  });
                } else {
                  onDownload(item.id, file, false);
                }
              }}
            >
              {file.thumbnailUrl ? (
                <img
                  src={file.thumbnailUrl}
                  alt={file.filename}
                  className="video-thumbnail-img"
                  onError={() => setImageFailed(true)}
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                    display: 'block'
                  }}
                />
              ) : (
                <div
                  className="video-placeholder-backdrop"
                  style={{
                    width: '100%',
                    height: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '6px',
                    color: 'var(--text-tertiary)'
                  }}
                >
                  <VideoIcon size={32} />
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                    Video Preview
                  </span>
                </div>
              )}
              <div
                className="video-play-overlay"
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'rgba(15, 14, 19, 0.35)',
                  backdropFilter: 'blur(2px)',
                  WebkitBackdropFilter: 'blur(2px)',
                }}
              >
                <div
                  className="video-play-circle"
                  style={{
                    width: '46px',
                    height: '46px',
                    borderRadius: '50%',
                    background: 'rgba(32, 30, 39, 0.88)',
                    border: '1px solid rgba(255, 255, 255, 0.22)',
                    backdropFilter: 'blur(10px)',
                    WebkitBackdropFilter: 'blur(10px)',
                    color: 'var(--accent)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.45)',
                    transition: 'transform var(--transition-fast, 150ms ease)'
                  }}
                >
                  <Play size={18} fill="currentColor" style={{ marginLeft: '2px' }} />
                </div>
              </div>
            </div>
          )}

          <div
            className="media-unified-footer"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '0.35rem',
              minWidth: 0,
              width: '100%'
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '0.5rem',
                minWidth: 0
              }}
            >
              <span
                className="file-row-title"
                title={file.filename}
                style={{
                  fontSize: '0.86rem',
                  fontWeight: 600,
                  letterSpacing: '-0.01em',
                  color: 'var(--text-primary)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  minWidth: 0,
                  flex: 1
                }}
              >
                {file.filename}
              </span>

              <div className="card-actions-group" style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexShrink: 0 }}>
                <button
                  type="button"
                  className="card-pill-btn"
                  onClick={() => {
                    if (isImageFile) {
                      const src = file.blobUrl || file.thumbnailUrl!;
                      onOpenMedia({
                        type: 'image',
                        src,
                        filename: file.filename,
                        fileSize: file.totalSize,
                        onDownload: () => onDownload(item.id, file, true)
                      });
                    } else if (isVideoFile) {
                      if (file.blobUrl) {
                        onOpenMedia({
                          type: 'video',
                          src: file.blobUrl,
                          filename: file.filename,
                          fileSize: file.totalSize,
                          onDownload: () => onDownload(item.id, file, true)
                        });
                      } else {
                        onDownload(item.id, file, false);
                      }
                    }
                  }}
                  title="Preview media"
                >
                  <Eye size={13} />
                  <span>Preview</span>
                </button>

                <button
                  type="button"
                  className="card-pill-btn card-pill-primary"
                  onClick={() => onDownload(item.id, file, true)}
                  disabled={file.isDownloading || file.status === 'saving'}
                  title="Save file"
                >
                  <Download size={13} />
                  <span>
                    {file.status === 'saving'
                      ? `Saving ${Math.round(file.progress || 0)}%`
                      : file.isDownloading
                      ? `${Math.round(file.progress || 0)}%`
                      : 'Save'}
                  </span>
                </button>

                <button
                  type="button"
                  className="card-icon-only-btn"
                  onClick={() => onDelete(item.id)}
                  title="Remove"
                  aria-label="Remove"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>

            <div style={{ width: '100%', minWidth: 0 }}>
              {renderDirectionMeta(`${formatBytes(file.totalSize)} · ${fileExt}`)}
            </div>
          </div>
        </div>
      )}

      {/* =========================================================
          4. RICH EMBEDDED VIEWERS (Audio / PDF / Code)
          ========================================================= */}
      {file && !file.isPendingApproval && !hasVisualMedia && hasRichEmbed && (
        <div className="embed-transfer-layout" style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
          <div
            className="embed-header-bar"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '0.5rem',
              paddingBottom: '0.45rem',
              borderBottom: '1px solid var(--border-subtle)',
              minWidth: 0
            }}
          >
            <div style={{ minWidth: 0, flex: 1, overflow: 'hidden' }}>
              <span
                className="file-row-title"
                title={file.filename}
                style={{
                  fontSize: '0.86rem',
                  fontWeight: 600,
                  color: 'var(--text-primary)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  display: 'block',
                  marginBottom: '2px'
                }}
              >
                {file.filename}
              </span>
              {renderDirectionMeta(`${formatBytes(file.totalSize)} · ${fileExt}`)}
            </div>

            <div className="card-actions-group" style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexShrink: 0 }}>
              <button
                type="button"
                className="card-pill-btn card-pill-primary"
                onClick={() => onDownload(item.id, file, true)}
                disabled={file.isDownloading}
                title="Save file"
              >
                <Download size={13} />
                <span>{file.isDownloading ? `${Math.round(file.progress || 0)}%` : 'Save'}</span>
              </button>
              <button
                type="button"
                className="card-icon-only-btn"
                onClick={() => onDelete(item.id)}
                title="Remove"
                aria-label="Remove"
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>

          <div
            className="embed-frame-wrapper"
            style={{
              borderRadius: 'var(--radius-sm)',
              overflow: 'hidden',
              border: '1px solid var(--border-subtle)',
              background: 'var(--surface-secondary)'
            }}
          >
            {file.blobUrl && file.mediaKind === 'audio' ? (
              <AudioPlayer
                src={file.blobUrl}
                filename={file.filename}
                fileSize={file.totalSize}
              />
            ) : file.blobUrl && file.mediaKind === 'pdf' ? (
              <PdfViewer
                src={file.blobUrl}
                filename={file.filename}
                fileSize={file.totalSize}
              />
            ) : file.snippet ? (
              <CodeViewer
                filename={file.filename}
                snippet={file.snippet}
                fullContent={file.fullContent}
                totalLines={file.totalLines}
                fileSize={file.totalSize}
                onCopyNotice={onToast}
              />
            ) : null}
          </div>
        </div>
      )}

      {/* =========================================================
          5. FILE CARD (Two-Row Apple Files Layout: Full-Width Meta)
          ========================================================= */}
      {file && !file.isPendingApproval && !hasVisualMedia && !hasRichEmbed && (
        <div
          className="file-card-layout"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '0.45rem',
            width: '100%',
            minWidth: 0
          }}
        >
          {/* Top row: Squircle Icon + Filename on left, Action buttons on right */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '0.65rem',
              width: '100%',
              minWidth: 0
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                minWidth: 0,
                flex: 1,
                overflow: 'hidden'
              }}
            >
              <div
                className="file-squircle-icon"
                style={{
                  width: '38px',
                  height: '38px',
                  borderRadius: '10px',
                  background: 'var(--surface-secondary)',
                  border: '1px solid var(--border-subtle)',
                  color: 'var(--accent)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0
                }}
              >
                {getFileIcon(file.filename, file.mediaKind)}
              </div>
              <span
                className="file-row-title"
                title={file.filename}
                style={{
                  fontSize: '0.88rem',
                  fontWeight: 600,
                  letterSpacing: '-0.01em',
                  color: 'var(--text-primary)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  minWidth: 0,
                  flex: 1
                }}
              >
                {file.filename}
              </span>
            </div>

            <div
              className="card-actions-group"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.35rem',
                flexShrink: 0
              }}
            >
              {/* If actively downloading or saving to disk, don't show preview or duplicate save pills */}
              {!file.isDownloading && file.status !== 'saving' && (
                <>
                  {/* Interrupted or Error: show Resume pill */}
                  {(!isSent && (file.status === 'interrupted' || file.status === 'paused' || !!file.error)) ? (
                    <button
                      type="button"
                      className="card-pill-btn card-pill-primary"
                      onClick={() => onResumeUpload(item.id)}
                      title="Resume download"
                    >
                      <RotateCcw size={13} />
                      <span>Resume</span>
                    </button>
                  ) : file.blobUrl ? (
                    /* Completed / Saved: Only images & videos retain in-app Preview lightbox */
                    (isImageFile || isVideoFile) && (
                      <button
                        type="button"
                        className="card-pill-btn"
                        onClick={() => {
                          if (isImageFile || isVideoFile) {
                            onOpenMedia({
                              type: isVideoFile ? 'video' : 'image',
                              src: file.blobUrl!,
                              filename: file.filename,
                              fileSize: file.totalSize,
                              onDownload: () => onDownload(item.id, file, true)
                            });
                          }
                        }}
                        title="Preview media"
                      >
                        <Eye size={13} />
                        <span>Preview</span>
                      </button>
                    )
                  ) : (
                    /* Ready to download: Only images & videos get Preview; all other files get single prominent Save button */
                    <>
                      {(isImageFile || isVideoFile) && (
                        <button
                          type="button"
                          className="card-pill-btn"
                          onClick={() => onDownload(item.id, file, false)}
                          title="Preview media"
                        >
                          <Eye size={13} />
                          <span>Preview</span>
                        </button>
                      )}
                      <button
                        type="button"
                        className="card-pill-btn card-pill-primary"
                        onClick={() => onDownload(item.id, file, true)}
                        title="Save to device"
                      >
                        <Download size={13} />
                        <span>Save</span>
                      </button>
                    </>
                  )}
                </>
              )}

              <button
                type="button"
                className="card-icon-only-btn"
                onClick={() => onDelete(item.id)}
                title="Remove"
                aria-label="Remove"
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>

          {/* Full-width metadata row: gives the entire width of the card to details! */}
          <div style={{ width: '100%', minWidth: 0, paddingLeft: '2px' }}>
            {renderDirectionMeta(`${formatBytes(file.totalSize)} · ${fileExt}`)}
          </div>
        </div>
      )}

      {/* =========================================================
          6. LIVE PROGRESS BAR (Active / Interrupted / Error Downloads)
          ========================================================= */}
      {file && !file.isPendingApproval && !isSent && (file.isDownloading || file.status === 'saving' || file.status === 'interrupted' || file.status === 'paused' || (!!file.error && (file.progress || 0) > 0)) && (
        <div className="progress-container" style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', paddingTop: '0.25rem' }}>
          <div
            className="progress-bar-track"
            style={{
              height: '4px',
              background: 'var(--surface-secondary)',
              borderRadius: 'var(--radius-full, 9999px)',
              overflow: 'hidden'
            }}
          >
            <div
              className="progress-bar-indicator"
              style={{
                height: '100%',
                background: file.status === 'saving'
                  ? 'var(--success)'
                  : file.isDownloading
                  ? 'var(--accent)'
                  : (file.status === 'interrupted' || file.status === 'paused')
                  ? 'var(--warning)'
                  : 'var(--error)',
                borderRadius: 'var(--radius-full, 9999px)',
                transition: 'width 140ms linear',
                width: `${Math.min(100, file.progress || 0)}%`
              }}
            />
          </div>
          <div
            className="progress-meta-row"
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              fontSize: '0.7rem',
              fontVariantNumeric: 'tabular-nums',
              color: file.status === 'saving'
                ? 'var(--success)'
                : file.isDownloading
                ? 'var(--text-secondary)'
                : (file.status === 'interrupted' || file.status === 'paused')
                ? 'var(--warning)'
                : 'var(--error)'
            }}
          >
            <span
              className="progress-status-label"
              style={{
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                minWidth: 0,
                flex: 1
              }}
            >
              {file.status === 'saving' ? (
                <>
                  Saving to Downloads · {Math.round(file.progress || 0)}%
                  {file.savedBytes ? ` (${formatBytes(file.savedBytes)} / ${formatBytes(file.totalSize)})` : ''}
                </>
              ) : file.isDownloading ? (
                <>
                  Receiving · {Math.round(file.progress || 0)}%
                  {file.speed ? ` · ${formatSpeed(file.speed)}` : ''}
                  {file.eta ? ` · ${file.eta}` : ''}
                </>
              ) : file.status === 'interrupted' ? (
                `Paused at ${Math.round(file.progress || 0)}% · Resumes on reconnect`
              ) : file.status === 'paused' ? (
                `Paused at ${Math.round(file.progress || 0)}%`
              ) : (
                `Failed at ${Math.round(file.progress || 0)}% · Tap Resume to retry`
              )}
            </span>

            <div className="progress-controls" style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', flexShrink: 0 }}>
              {!file.isDownloading && file.status !== 'saving' && (
                <button
                  type="button"
                  className="progress-ctrl-btn"
                  onClick={() => onResumeUpload(item.id)}
                  title="Resume download"
                  aria-label="Resume download"
                  style={{
                    background: 'var(--surface-secondary)',
                    border: '1px solid var(--border-subtle)',
                    color: 'var(--accent)',
                    width: '22px',
                    height: '22px',
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer'
                  }}
                >
                  <RotateCcw size={11} />
                </button>
              )}
              {file.status !== 'saving' && (
                <button
                  type="button"
                  className="progress-ctrl-btn progress-cancel"
                  onClick={() => onCancelUpload(item.id, file.transferId)}
                  title="Cancel download"
                  aria-label="Cancel download"
                  style={{
                    background: 'var(--surface-secondary)',
                    border: '1px solid var(--border-subtle)',
                    color: 'var(--text-secondary)',
                    width: '22px',
                    height: '22px',
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer'
                  }}
                >
                  <X size={11} />
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {file && !file.isPendingApproval && isSent && file.status && file.status !== 'done' && (
        <div className="progress-container" style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', paddingTop: '0.25rem' }}>
          {file.status !== 'canceled' && (
            <div
              className="progress-bar-track"
              style={{
                height: '4px',
                background: 'var(--surface-secondary)',
                borderRadius: 'var(--radius-full, 9999px)',
                overflow: 'hidden'
              }}
            >
              <div
                className="progress-bar-indicator"
                style={{
                  height: '100%',
                  background: file.status === 'error'
                    ? 'var(--error)'
                    : file.status === 'paused'
                    ? 'var(--warning)'
                    : 'var(--accent)',
                  borderRadius: 'var(--radius-full, 9999px)',
                  transition: 'width 140ms linear',
                  width: `${Math.min(100, file.progress || 0)}%`
                }}
              />
            </div>
          )}

          <div
            className="progress-meta-row"
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              fontSize: '0.7rem',
              fontVariantNumeric: 'tabular-nums',
              color: 'var(--text-secondary)',
              minWidth: 0,
              gap: '0.5rem'
            }}
          >
            <span
              className="progress-status-label"
              style={{
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                minWidth: 0,
                flex: 1,
                color: file.status === 'error'
                  ? 'var(--error)'
                  : file.status === 'interrupted' || file.status === 'paused'
                  ? 'var(--warning)'
                  : 'var(--text-secondary)'
              }}
            >
              {file.status === 'uploading' && (
                <>
                  {Math.round(file.progress || 0)}% · {formatSpeed(file.speed || 0)}
                  {file.eta ? ` · ${file.eta}` : ''}
                </>
              )}
              {file.status === 'queued' && (file.priority === 'high' ? 'Queued · High Priority' : 'Queued...')}
              {file.status === 'paused' && (file.priority === 'high' ? 'Paused · High Priority' : 'Paused')}
              {file.status === 'interrupted' && 'Interrupted — auto-resumes on reconnect'}
              {file.status === 'canceled' && 'Canceled'}
              {file.status === 'error' && (file.error || 'Transfer failed')}
            </span>

            <div className="progress-controls" style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', flexShrink: 0 }}>
              {(file.status === 'queued' || file.status === 'paused') && onTogglePriority && (
                <button
                  type="button"
                  className={`progress-ctrl-btn ${file.priority === 'high' ? 'priority-active' : ''}`}
                  onClick={() => onTogglePriority(item.id)}
                  title={file.priority === 'high' ? 'High Priority (Tap to reset)' : 'Prioritize in queue'}
                  aria-label="Prioritize transfer"
                  style={{
                    background: file.priority === 'high' ? 'var(--accent)' : 'var(--surface-secondary)',
                    borderColor: file.priority === 'high' ? 'var(--accent)' : 'var(--border-subtle)',
                    color: file.priority === 'high' ? '#17161D' : 'var(--text-secondary)',
                    width: '22px',
                    height: '22px',
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    border: '1px solid var(--border-subtle)'
                  }}
                >
                  <ArrowUp size={11} strokeWidth={2.5} />
                </button>
              )}
              {file.status === 'uploading' && (
                <button
                  type="button"
                  className="progress-ctrl-btn"
                  onClick={() => onPauseUpload(item.id)}
                  title="Pause"
                  aria-label="Pause"
                  style={{
                    background: 'var(--surface-secondary)',
                    border: '1px solid var(--border-subtle)',
                    color: 'var(--text-secondary)',
                    width: '22px',
                    height: '22px',
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer'
                  }}
                >
                  <Pause size={11} />
                </button>
              )}
              {(file.status === 'paused' || file.status === 'error' || file.status === 'interrupted') && (
                <button
                  type="button"
                  className="progress-ctrl-btn"
                  onClick={() => onResumeUpload(item.id)}
                  title={file.status === 'error' ? 'Retry transfer' : 'Resume'}
                  aria-label={file.status === 'error' ? 'Retry transfer' : 'Resume'}
                  style={{
                    background: 'var(--surface-secondary)',
                    border: '1px solid var(--border-subtle)',
                    color: 'var(--accent)',
                    width: '22px',
                    height: '22px',
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer'
                  }}
                >
                  {file.status === 'error' ? <RotateCcw size={11} /> : <Play size={11} />}
                </button>
              )}
              {file.status !== 'canceled' && file.status !== 'done' && (
                <button
                  type="button"
                  className="progress-ctrl-btn progress-cancel"
                  onClick={() => onCancelUpload(item.id, file.transferId)}
                  title="Cancel"
                  aria-label="Cancel"
                  style={{
                    background: 'var(--surface-secondary)',
                    border: '1px solid var(--border-subtle)',
                    color: 'var(--text-secondary)',
                    width: '22px',
                    height: '22px',
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer'
                  }}
                >
                  <X size={11} />
                </button>
              )}
            </div>
          </div>

          {file.error && (
            <div
              className="transfer-error-notice"
              style={{
                fontSize: '0.73rem',
                color: 'var(--error)',
                padding: '0.3rem 0.55rem',
                borderRadius: '6px',
                background: 'var(--error-subtle)',
                border: '1px solid var(--error-border)',
                lineHeight: 1.35
              }}
            >
              {file.error}
            </div>
          )}
        </div>
      )}
    </article>
  );
};
