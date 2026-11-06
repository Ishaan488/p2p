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
    /** Key of the stored preview copy; shared by every recipient of one sent file. */
    cacheKey?: string;
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
  /** The PC this was sent to / received from, and its name at the time (survives unpairing). */
  peerId?: string;
  peerName?: string;
  /** For text sent to several PCs at once: one card, every recipient. */
  peerIds?: string[];
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
  onRejectApproval: (id: string, file?: TransferItem['file']) => void;
  onPauseUpload: (id: string) => void;
  onResumeUpload: (id: string) => void;
  onCancelUpload: (id: string, transferId: string) => void;
  onTogglePriority?: (id: string) => void;
  onToast: (text: string, type?: 'info' | 'success' | 'warning') => void;
  /** Shown as a small tag when transfers with several PCs share the list. */
  peerLabel?: string;
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
  onToast,
  peerLabel
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [justCopied, setJustCopied] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);

  const isSent = item.sender === 'me';
  const file = item.file;

  // Preview for a file this phone is sending must come from a local blob: the
  // PC has no "download" record for an upload, so asking it to serve one back
  // just hangs and then fails. That local blob is missing only for a sent file
  // too large to keep a preview copy of (see materializeToBlob's size caps).
  const previewUnavailable = () =>
    onToast('Preview unavailable for this file (too large to keep a local copy).', 'warning');

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
    (!!file?.blobUrl && (file.mediaKind === 'audio' || file.mediaKind === 'pdf')) ||
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

      {peerLabel && (
        <span className="peer-tag" title={`${isSent ? 'To' : 'From'} ${peerLabel}`}>
          {isSent ? 'to' : 'from'}&nbsp;{peerLabel}
        </span>
      )}

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
    <article className={`transfer-card ${isDeleting ? 'deleting' : ''}`}>
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
                  padding: '0.35rem 0',
                  minHeight: '36px'
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

            <div className="card-actions-group" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
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
              gap: '0.5rem',
              paddingTop: '0.2rem',
              alignItems: 'center'
            }}
          >
            <button
              type="button"
              className="approval-btn approval-reject"
              onClick={() => onRejectApproval(item.id, file)}
              style={{
                flex: 1,
                minHeight: '44px',
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
                transition: 'transform 100ms ease, background 150ms ease, border-color 150ms ease'
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
                minHeight: '44px',
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
                transition: 'transform 100ms ease, background 150ms ease'
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
                minHeight: '44px',
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
                transition: 'transform 100ms ease, background 150ms ease, border-color 150ms ease'
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
              role="button"
              tabIndex={0}
              aria-label={`Preview ${file.filename}`}
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
                  onDownload: !isSent ? () => onDownload(item.id, file, true) : undefined
                });
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  const src = file.blobUrl || file.thumbnailUrl!;
                  onOpenMedia({
                    type: 'image',
                    src,
                    filename: file.filename,
                    fileSize: file.totalSize,
                    onDownload: !isSent ? () => onDownload(item.id, file, true) : undefined
                  });
                }
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
              role="button"
              tabIndex={0}
              aria-label={`Preview ${file.filename}`}
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
                    onDownload: !isSent ? () => onDownload(item.id, file, true) : undefined
                  });
                } else if (isSent) {
                  previewUnavailable();
                } else {
                  onDownload(item.id, file, false);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  if (file.blobUrl) {
                    onOpenMedia({
                      type: 'video',
                      src: file.blobUrl,
                      filename: file.filename,
                      fileSize: file.totalSize,
                      onDownload: !isSent ? () => onDownload(item.id, file, true) : undefined
                    });
                  } else if (isSent) {
                    previewUnavailable();
                  } else {
                    onDownload(item.id, file, false);
                  }
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

              <div className="card-actions-group" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
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
                        onDownload: !isSent ? () => onDownload(item.id, file, true) : undefined
                      });
                    } else if (isVideoFile) {
                      if (file.blobUrl) {
                        onOpenMedia({
                          type: 'video',
                          src: file.blobUrl,
                          filename: file.filename,
                          fileSize: file.totalSize,
                          onDownload: !isSent ? () => onDownload(item.id, file, true) : undefined
                        });
                      } else if (isSent) {
                        previewUnavailable();
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

                {!isSent && (
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

            <div className="card-actions-group" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
              {!isSent && (
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
                onDownload={!isSent ? () => onDownload(item.id, file, true) : undefined}
              />
            ) : file.blobUrl && file.mediaKind === 'pdf' ? (
              <PdfViewer
                src={file.blobUrl}
                filename={file.filename}
                fileSize={file.totalSize}
                onDownload={!isSent ? () => onDownload(item.id, file, true) : undefined}
              />
            ) : file.snippet ? (
              <CodeViewer
                filename={file.filename}
                snippet={file.snippet}
                fullContent={file.fullContent}
                totalLines={file.totalLines}
                fileSize={file.totalSize}
                onDownload={!isSent ? () => onDownload(item.id, file, true) : undefined}
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
                gap: '0.5rem',
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
                  ) : (
                    <>
                      {/* 1. Preview / Open button: images & videos open lightbox; other files with blobUrl open in viewer/tab */}
                      {(isImageFile || isVideoFile) ? (
                        <button
                          type="button"
                          className="card-pill-btn"
                          onClick={() => {
                            if (file.blobUrl) {
                              onOpenMedia({
                                type: isVideoFile ? 'video' : 'image',
                                src: file.blobUrl,
                                filename: file.filename,
                                fileSize: file.totalSize,
                                onDownload: !isSent ? () => onDownload(item.id, file, true) : undefined
                              });
                            } else if (isSent) {
                              previewUnavailable();
                            } else {
                              onDownload(item.id, file, false);
                            }
                          }}
                          title="Preview media"
                        >
                          <Eye size={13} />
                          <span>Preview</span>
                        </button>
                      ) : file.blobUrl ? (
                        <button
                          type="button"
                          className="card-pill-btn"
                          onClick={() => {
                            if (file.blobUrl) {
                              window.open(file.blobUrl, '_blank');
                            }
                          }}
                          title="Open / View file"
                        >
                          <ExternalLink size={13} />
                          <span>Open</span>
                        </button>
                      ) : null}

                      {/* 2. Prominent Save button: ALWAYS available for incoming files across all formats */}
                      {!isSent && (
                        <button
                          type="button"
                          className="card-pill-btn card-pill-primary"
                          onClick={() => onDownload(item.id, file, true)}
                          title="Save to Downloads"
                        >
                          <Download size={13} />
                          <span>Save</span>
                        </button>
                      )}
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
            role="progressbar"
            aria-valuenow={Math.round(file.progress || 0)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${file.filename} transfer progress`}
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
                width: '100%',
                height: '100%',
                background: file.status === 'saving'
                  ? 'var(--success)'
                  : file.isDownloading
                  ? 'var(--accent)'
                  : (file.status === 'interrupted' || file.status === 'paused')
                  ? 'var(--warning)'
                  : 'var(--error)',
                borderRadius: 'var(--radius-full, 9999px)',
                transformOrigin: 'left center',
                transition: 'transform 140ms cubic-bezier(0.16, 1, 0.3, 1)',
                transform: `scaleX(${Math.max(0, Math.min(1, (file.progress || 0) / 100))})`
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
              role="status"
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

            <div className="progress-controls" style={{ display: 'flex', alignItems: 'center', gap: '0.55rem', flexShrink: 0 }}>
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
                    width: '32px',
                    height: '32px',
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer'
                  }}
                >
                  <RotateCcw size={13} />
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
                    width: '32px',
                    height: '32px',
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer'
                  }}
                >
                  <X size={13} />
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
              role="progressbar"
              aria-valuenow={Math.round(file.progress || 0)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${file.filename} transfer progress`}
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
                  width: '100%',
                  height: '100%',
                  background: file.status === 'error'
                    ? 'var(--error)'
                    : file.status === 'paused'
                    ? 'var(--warning)'
                    : 'var(--accent)',
                  borderRadius: 'var(--radius-full, 9999px)',
                  transformOrigin: 'left center',
                  transition: 'transform 140ms cubic-bezier(0.16, 1, 0.3, 1)',
                  transform: `scaleX(${Math.max(0, Math.min(1, (file.progress || 0) / 100))})`
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
              role="status"
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

            <div className="progress-controls" style={{ display: 'flex', alignItems: 'center', gap: '0.55rem', flexShrink: 0 }}>
              {(file.status === 'queued' || file.status === 'paused') && onTogglePriority && (
                <button
                  type="button"
                  className={`progress-ctrl-btn ${file.priority === 'high' ? 'priority-active' : ''}`}
                  onClick={() => onTogglePriority(item.id)}
                  title={file.priority === 'high' ? 'High Priority (Tap to reset)' : 'Prioritize in queue'}
                  aria-label="Prioritize transfer"
                  aria-pressed={file.priority === 'high'}
                  style={{
                    background: file.priority === 'high' ? 'var(--accent)' : 'var(--surface-secondary)',
                    borderColor: file.priority === 'high' ? 'var(--accent)' : 'var(--border-subtle)',
                    color: file.priority === 'high' ? '#17161D' : 'var(--text-secondary)',
                    width: '32px',
                    height: '32px',
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    border: '1px solid var(--border-subtle)'
                  }}
                >
                  <ArrowUp size={13} strokeWidth={2.5} />
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
                    width: '32px',
                    height: '32px',
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer'
                  }}
                >
                  <Pause size={13} />
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
                    width: '32px',
                    height: '32px',
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer'
                  }}
                >
                  {file.status === 'error' ? <RotateCcw size={13} /> : <Play size={13} />}
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
                    width: '32px',
                    height: '32px',
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer'
                  }}
                >
                  <X size={13} />
                </button>
              )}
            </div>
          </div>

          {file.error && (
            <div
              className="transfer-error-notice"
              role="alert"
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
